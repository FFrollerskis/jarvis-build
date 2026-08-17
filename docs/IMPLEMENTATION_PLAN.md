# Jarvis – implementeringsplan (ti faser)

**Status:** Utkast v1.0 – venter på godkjenning av fase 1 før kode skrives.
Fasene følger masterplanens ti-delte byggeplan, med fase 1 omdefinert til et kjørbart fundament
(beslutning D-11 i [DECISIONS_AND_ASSUMPTIONS.md](DECISIONS_AND_ASSUMPTIONS.md)).

Hver fase har: formål, avgrensning, komponenter, avhengigheter, leveranser, tester,
akseptansekriterier og eksplisitt ikke-innhold. Estimatene er arbeidsuker ved deltid + AI-agenter.

---

## Fase 1 – Kjørbart sikkerhets- og prosjektfundament (1–2 uker)

**Formål:** Et lite, fungerende fundament: monorepo som bygger og tester grønt, typede kjerne-kontrakter,
og et policy-skjelett som beviselig avviser uautoriserte kritiske handlinger – pluss sikkerhets- og
personverndokumentene som styrer alt videre.

**Avgrensning:** Ingen LLM-kall, ingen database utover det policy-testene trenger, ingen UI, ingen tale.

**Komponenter:**
- Monorepo-skjelett (pnpm workspaces): `packages/contracts`, `modules/policy`, `apps/api` (kun helse-endepunkt), `infra/local` (docker-compose-stub)
- `packages/contracts` v0: identitetskontekst (`person_id` … `delegation_id`), capability-klasser A–D, godkjenningsobjekt, jobbkontrakt, hendelsesformat – som typer + JSON-skjemaer
- Policy Gateway-skjelett: `authorize()` med regelmotor for klasse-sjekk og godkjenningsvalidering (signaturverifisering med testnøkler)
- Kill switch-stub (flagg som stopper all autorisasjon)
- Dokumenter: trusselmodell, DPIA-utkast inkl. talelyd, tenantmodell, secrets-strategi (SOPS + age), region-/databehandlermatrise med felter for LLM/STT/TTS/realtime, runbook-mal
- CI (GitHub Actions): lint, typecheck, test på hver push

**Avhengigheter:** Godkjent spesifikasjon (dette dokumentsettet). Node 22, pnpm, Git.

**Leveranser:** Byggende repo med CI grønn; kontrakter v0; policytester; sikkerhetsdokumentene over;
`.gitignore`/`.env.example`/SOPS-oppsett som gjør det umulig å committe secrets ved uhell (gitleaks i CI).

**Tester:** Enhetstester for policy-skjelettet; skjemavalidering av kontraktene; gitleaks-scan.

**Akseptansekriterier:**
1. `pnpm test` kjører grønt lokalt og i CI.
2. Policytest: klasse D-kall uten gyldig signert godkjenning → `Deny`, logget.
3. Policytest: gyldig godkjenning med feil parametere, utløpt tid eller brukt engangs-ID → `Deny`.
4. Kill switch aktivert → alle kall nektes.
5. Region-/databehandlermatrisen har eksplisitte felter for LLM, STT, TTS og realtime.
6. gitleaks finner ingen secrets; `.env` er git-ignorert.

**Bygges IKKE i denne fasen:** Database-skjema (utover teststubber), LLM-integrasjon, webchat, minne,
tale, integrasjoner, vault-tjeneste, watchdog.

---

## Fase 2 – Identitet, kontrakter og datafundament (1–2 uker)

**Formål:** Autoritativ datamodell med bevist tenant-isolasjon: identitet, sesjoner, hendelser og jobber i
PostgreSQL med Row Level Security.

**Avgrensning:** Ingen LLM, ingen minne-intelligens (kun rå tabeller), ingen UI.

**Komponenter:**
- Postgres 16-container (pgvector, pgmq aktivert) i `infra/local`
- Versjonerte migrasjoner: `people`, `organizations`, `tenants`, `projects`, `devices`, `sites`, `rooms`, `sessions`, `messages`, `events` (append-only), `tasks`, `memory_spaces`, `capabilities`, `approvals`, `audit_events`, `cost_events`
- RLS-policyer per tenant og memory space
- Identity Service og Session Service (kontrakter fra fase 1 → kjørende kode)
- Idempotent hendelsesskriving (engangs-ID-er)
- Audit-skriver (append-only, egen modul)

**Avhengigheter:** Fase 1.

**Leveranser:** Kjørende Postgres med migrasjoner; identitets- og sesjonstjeneste med API; audit-logg.

**Tester:** RLS-tester (tenant A kan aldri lese tenant B – testet på SQL-nivå med ulike roller);
idempotens-tester (samme hendelse to ganger → én rad); sesjonsgjenopptak på tvers av kanal.

**Akseptansekriterier:**
1. Automatiske tester beviser tenant-isolasjon på databasenivå.
2. Hendelser er idempotente.
3. En sesjon opprettet på kanal A gjenopptas gyldig fra kanal B med samme `session_id`.
4. Alle skrivinger produserer audit-hendelser med full identitetskontekst.

**Bygges IKKE:** Embeddings, relasjonslag, sammendrag, LLM-kall, UI, verktøy.

---

## Fase 3 – Jarvis Core og tekst-MVP (2–3 uker)

**Formål:** Første samtale med Jarvis: webchat med streaming, modellgateway med kostnadssporing,
rask ruter, enkel kontekstbygger og jobbopprettelse.

**Avgrensning:** Minnet er kun sesjonshistorikk + strukturerte oppslag (hybridminne kommer i fase 4).
Verktøy begrenses til klasse A + én klasse B-demo + én klasse D-stub (for policytest).

**Komponenter:**
- Conversation Engine med streaming (SSE/WebSocket)
- Model Gateway: adaptere for Anthropic + OpenAI + én lokal modell (Ollama-klasse); budsjett/fallback/rate limits; kostnad per kall → `cost_events` knyttet til `task_id`/`session_id`; håndhevet 1 000/2 000/3 000 kr-logikk
- Fast Router v1: deterministisk intentmatch (regex/grammatikk + liten klassifiseringsmodell ved behov) for status/oppgave-kommandoer
- Context Builder v1: sesjonshistorikk + strukturerte oppslag innen space-autorisasjon
- Task Service: opprette/følge/avbryte jobber (kjøres foreløpig in-process bak `WorkflowAdapter` med pg-boss-klasse kø)
- Webchat (`apps/web`, Next.js-klasse) med sesjonsvisning og jobbstatus
- Langfuse selvhostet; alle modellkall traces

**Avhengigheter:** Fase 2. API-nøkler (Anthropic/OpenAI) i lokal SOPS-konfig.

**Leveranser:** Fungerende tekst-Jarvis lokalt: samtale, jobbopprettelse, kostnadsvisning, observability.

**Tester:** E2E: samtale oppretter jobb og følger den til fullført; kostnads-hardgrense i test-modus
blokkerer kall; policytest mot klasse D-stub; Fast Router-presisjon på definert kommandosett.

**Akseptansekriterier:**
1. En samtale kan opprette en jobb og følge den til sluttstatus.
2. Hvert modellkall har kostnad knyttet til `task_id`/`session_id`, synlig i Langfuse.
3. Kritisk verktøy (klasse D-stub) blokkeres uten gyldig godkjenning – i den kjørende appen, ikke bare i enhetstest.
4. Kjente kommandoer besvares av Fast Router uten LLM-kall (verifisert i trace).
5. Simulert månedskostnad over hardgrense → nye kall nektes med tydelig feilmelding.

**Bygges IKKE:** Hybridminne, tale, eksterne integrasjoner (utover modell-APIer), mobil, agentprofiler
utover enkel executive-prompt.

---

## Fase 4 – Hybridminne v1 (2–4 uker)

**Formål:** Det livslange minnet: alle syv lag, skriveflyt med karantene, og eval-sett som beviser
kvalitet og isolasjon.

**Avgrensning:** Minne skrives fra samtaler og manuelt importerte dokumenter – ikke fra eksterne
integrasjoner (de kommer i fase 7).

**Komponenter:**
- Migrasjoner: `memory_items`, `memory_versions`, `memory_sources`, `entities`, `relations`, `summaries`, `embeddings`, `decisions`, `commitments`, `deadlines`
- Memory Writer: uttrekk (LLM-assistert med billig modell), dedup, ADD/UPDATE/INVALIDATE/NOOP, konfliktversjonering, karantene for ubetrodd innhold
- Fulltekst (tsvector norsk+engelsk) og pgvector (HNSW) med embedding-pipeline
- Relasjonslag med rekursive spørringer (1–2 hopp)
- Sammendragsjobber (daglig/prosjekt)
- Context Builder v2: hybrid retrieval + reranking + tidsfilter + kildemerking
- Menneskelesbar eksport til mappestruktur
- Eval-rammeverk + sett (start: 50 spørsmål, syntetisk + kuratert; utvides med reell historikk)

**Avhengigheter:** Fase 3.

**Leveranser:** Jarvis husker på tvers av sesjoner med kildeangivelse; eksport; kjørbar eval-suite i CI.

**Tester:** Eval-suiten (korrekthet, kilde, tid, motstrid, tilgangsnekt, kryss-tenant); enhetstester for
skriveflyt; ytelsestest på retrieval-latens (<300 ms P95 lokalt for hybridsøk).

**Akseptansekriterier:**
1. Eval: svar oppgir kilde; tidsspørsmål bruker `valid_from`/`valid_to`; motstrid vises med begge versjoner.
2. Eval: **null kryss-tenant-lekkasje** og null space-lekkasje (health/guest-tester inkludert).
3. Karantene: ubetrodd innhold blir aldri autoritativt uten godkjenningssteg.
4. Eksporten genereres komplett fra databasen og inngår i backup.

**Bygges IKKE:** Grafdatabase, automatisk import fra e-post/kalender, memory curator-agent.

---

## Fase 5 – Voice Gateway vertikal prototype (timebox: 2×2 uker + stop/go)

**Formål:** Én vertikal talesti med ekte full-duplex: terminal → Voice Gateway → streaming STT → Core →
streaming TTS → terminal, med VAD, AEC, støyreduksjon, barge-in og sesjonsgjenopptak.

**Avgrensning:** Én satellitt/klient, ett rom. Ingen multi-rom, ingen wake-word-finpuss utover valgt løsning.

**Komponenter:**
- `apps/voice-gateway`: egen prosess; WebRTC (LiveKit-kandidat eller ren mediasoup/aiortc – besluttes av prototypen); VAD; barge-in-logikk; sesjonskobling mot Core
- `SpeechAdapter` med minst to STT- og to TTS-leverandører (minst én lokal)
- Norsk benchmark: ≥100 lydprøver, WER/latens/pris/datavilkår for STT, naturlighet/latens for TTS
- Tale-DPIA fullført; reservevei (HA Assist) dokumentert og testet
- Latensinstrumentering ende-til-ende (P50/P95)

**Avhengigheter:** Fase 3 (Core-samtale). Fase 4 er nyttig, ikke blokkerende.

**Leveranser:** Kjørende talepilot i ett rom; benchmark-rapport; stop/go-beslutningsnotat.

**Tester:** Barge-in-måling (automatisert avspillingstest); failover-test (gateway-restart midt i samtale →
samme sesjon, ingen dobbel verktøyhandling); latens-P95-målinger; benchmark-suite.

**Akseptansekriterier:**
1. Barge-in stopper avspilling ≤250 ms ved ren tale.
2. Median talerespons <1,5 s (målt, med P95 rapportert).
3. Enkel kommando via tale rutes deterministisk uten stor LLM.
4. Sesjon gjenopptas etter failover uten doble handlinger.
5. Stop/go-beslutning tatt på benchmark-data; ved «ingen leverandør når målet» skal beslutningen
   eksplisitt velge lokal STT/TTS eller justerte mål – ikke stille aksept.

**Bygges IKKE:** Flere rom, hytte, bil, telefonapp-tale, wake-word-trening, HA-talepipeline som hovedvei.

---

## Fase 6 – Oppgaver og isolerte workers (2–4 uker)

**Formål:** Varige bakgrunnsjobber med agentprofiler og sandboxet kjøring: en kodejobb kjører isolert,
lager PR og overlever frakobling.

**Avgrensning:** Agentprofiler = de fire MVP-profilene. Kun GitHub som ekstern integrasjon (foregriper
fase 7 minimalt og kun for PR-flyt).

**Komponenter:**
- Worker-prosess bak `WorkflowAdapter`: checkpoints, retries, resume; evaluering pg-boss-klasse vs. Trigger.dev/Hatchet gjøres her med reelle jobber (beslutning dokumenteres)
- Jobbkontrakt håndhevet: mål, akseptansekriterier, tillatte verktøy/nettverksmål, budsjett, maks steg, frist
- Sandbox-runner: kastbar Docker/WSL2-container per jobb, nettverksallowlist, jobbspesifikke tokens
- Agentprofiler: Executive, Coding (Claude Code/Codex headless), Research, Verifier
- Artefaktlagring og kobling til `task_id`

**Avhengigheter:** Fase 3; fase 4 for minnetilgang i jobber.

**Leveranser:** Kodejobb ende-til-ende: oppdrag → sandbox → branch/PR → tester → verifier-rapport →
varsel; jobber kan pauses/gjenopptas/stoppes.

**Tester:** Frakoblingstest (klient dør, jobb fullfører); stopp/resume; nettverksallowlist-test (jobb når
ikke ikke-tillatte mål); token-scope-test; løkkedeteksjon (maks steg stopper jobben).

**Akseptansekriterier:**
1. En jobb overlever klientfrakobling og kan stoppes og gjenopptas.
2. Kodejobb kjører isolert, lager branch/PR, kjører tester og rapporterer artefakter.
3. Ingen produksjonsmerge uten menneskelig gate (verifisert i GitHub-innstillinger + test).
4. Jobb uten gyldig kontrakt (manglende budsjett/mål) avvises av Task Service.

**Bygges IKKE:** Flere agentroller, autonom multi-agent-orkestrering, selvreparasjon.

---

## Fase 7 – Første integrasjoner (2–4 uker)

**Formål:** Tool Gateway i full drift med første bølge: GitHub, kalender, e-post, Drive/Docs, Telegram,
Vercel – hver med scopes, audit, rate limit, rollback og injection-test.

**Avgrensning:** Første bølge kun (se INTEGRATIONS §3). Lesing før skriving; skriving med godkjenning.

**Komponenter:**
- Tool Gateway: verktøyregister (skjema, klasse, scopes, rate limit, rollback, credential-referanse)
- Integrasjonene: GitHub (utvidet), Google Calendar, Gmail, Drive/Docs, Telegram (varsling + godkjenningskanal), Vercel
- Ingestion-pipeline: e-post/dokumenter → Ingestion Zone → karantene → strukturert uttrekk → minne
- Prompt injection-testsuite (automatisert, per verktøy)
- Vault innført (Infisical/OpenBao – valg per Q-05 tas her, senest nå per D-16) – secrets flyttes fra SOPS-filer til vault med rotasjon

**Avhengigheter:** Fase 4 (minne for ingest), fase 6 (jobber som bruker verktøy).

**Leveranser:** Jarvis leser e-post/kalender inn i minnet (med karantene), sender Telegram-varsler, lager
kalenderutkast med godkjenning; alle verktøykall sporbare.

**Tester:** Injection-suite (eksfiltrering og uautoriserte handlinger skal feile); scope-tester (token kan
ikke mer enn definert); rate limit; rollback-prosedyrer; tokenutløpsvarsling.

**Akseptansekriterier:**
1. Hvert verktøy har scopes, audit, rate limit, rollback og bestått injection-test.
2. E-postinnhold kan aldri utløse utgående handling uten godkjenningssteg (testet).
3. Alle verktøykall spores til person, jobb, policybeslutning og credential.
4. Secrets ligger i vault; ingen langlivede nøkler i miljøfiler.

**Bygges IKKE:** Andre bølge-integrasjoner (CRM, økonomi, telefoni, Slack), autosend av e-post uten
godkjenning.

---

## Fase 8 – Mobil, Watch og kontinuitet (4–8 uker)

**Formål:** Jarvis i lomma: native iPhone-app med samme sesjon som web/tale, push, App Intents,
Action Button, Live Activity for jobber, AirPods-tale og Watch-godkjenninger (signerte klasse
D-godkjenninger fra håndleddet).

**Avgrensning:** iOS/watchOS først (antakelse A-05). Apple-begrensninger styrer ambisjonsnivå; målene
justeres mot faktiske API-muligheter, ikke omvendt.

**Komponenter:** `apps/mobile` (Swift/SwiftUI), sesjons-API-klient, push-infrastruktur, App Intents,
Watch-app med godkjenningssignering (enhetsnøkkel i Secure Enclave), Live Activity, bakgrunnslyd
mot Voice Gateway.

**Avhengigheter:** Fase 3 (sesjoner), fase 5 (tale), fase 7 (varsling); Apple-utviklerkonto.

**Leveranser:** App i TestFlight: samtale (tekst+tale), jobbstatus, push, Watch-godkjenning.

**Tester:** Kanalbytte-test (samtale web → mobil → tale); godkjenningssignering verifiseres
kryptografisk; låst-telefon-scenarier.

**Akseptansekriterier:**
1. Aktiv samtale fortsetter mellom web, telefon og rom-satellitt.
2. Klasse D-godkjenning fungerer fra Watch på låst telefon (innen Apples API-grenser).
3. Push-varsel om jobbstatus kommer innen sekunder.

**Bygges IKKE:** Android, CarPlay (senere), desktop-app, offline-modus utover grunnleggende.

---

## Fase 9 – Home Assistant, hus og steder (2–6 uker første sted)

**Formål:** Huset kobles på: HA som enhetsbuss gjennom Tool Gateway, stedsriktige kommandoer,
flere satellitter, lokal robusthet.

**Avgrensning:** Ett sted (huset) først; hytta er kopi-oppsett senere. Sikkerhetsautomasjoner forblir
deterministiske i HA.

**Komponenter:** HA-integrasjon (klasse B for lys/klima, klasse D for lås/alarm), rommetadata-mapping
(`site_id`/`room_id`), lokale hurtigkommandoer (satellitt → HA direkte for kritiske kommandoer),
flere rom-satellitter, HA Assist-fallback konfigurert, lokal watchdog per sted.

**Avhengigheter:** Fase 5 (tale), fase 7 (Tool Gateway).

**Leveranser:** Talestyrt hus med stedsforståelse; dokumentert fallback-oppførsel.

**Tester:** Skybrudd-test (internett kuttes → lokale kommandoer og sikkerhetsautomasjoner virker);
romfeil-test (én satellitt dør → resten virker); klasse D-test på lås/alarm.

**Akseptansekriterier:**
1. Huset tåler skybrudd og en romfeil uten at kritiske automasjoner stopper.
2. «Skru på lyset her» virker riktig per rom.
3. Lås/alarm krever signert godkjenning – også via tale.

**Bygges IKKE:** Hytte (eget prosjekt etter mønster), bil, energioptimalisering, kamera-analyse.

---

## Fase 10 – Drift, skalering og egen infrastruktur (kontinuerlig)

**Formål:** Gjøre Jarvis pålitelig som tjeneste: full watchdog, testet restore, kostnadsanalyse og
datadrevet beslutning om flytting til egen node/server/sky.

**Avgrensning:** Ingen nye funksjoner; kun drift, måling og migrasjon.

**Komponenter:** Watchdog komplett (alle sjekker fra masterplan §11.2, ekstern + lokal), restore-øvelser
med tidtaking, 30–90 dagers målerapport (kostnad, oppetid, latens, lokal modell-økonomi),
beslutningsgrunnlag for dedikert AI-server (RTX 5080-klasse) hvis tallene tilsier det (D-20),
runbooks for alle Tier 1-tjenester.

**Avhengigheter:** Fase 1–7 i produksjon (8–9 kan pågå parallelt).

**Leveranser:** Driftshåndbok; verifisert backup/restore; beslutningsnotat om infrastruktur; alarmering
komplett.

**Tester:** Simulert feil → watchdog varsler Telegram med runbook; full restore av Tier 1 innen RTO;
kill switch-øvelse; kostnadsgrense-øvelse.

**Akseptansekriterier:**
1. Watchdog oppdager simulert feil og varsler med alvorlighetsgrad og runbook.
2. Tier 1 gjenopprettes innen dokumentert RTO/RPO med målt tid.
3. Kostnad synlig per modell, agent, tenant og oppgave; grensene håndheves og er testet.
4. Alle Tier 1-tjenester har eier, runbook, alarm og failover-beskrivelse.

**Bygges IKKE:** Autonom selvreparasjon utover signerte runbooks; store maskinvarekjøp uten måldata.

---

## Overgang til masterplan v4.0 «Sovereign Autonomy» (UA-N)

Fase 1–10 over følger masterplan v2.1s ti-delte byggeplan og er historisk korrekte for det de dekker.
Byggingen har siden UA-0 (≈ fase 1–3s kjerne) fulgt masterplan v4.0
([docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md](input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md)),
som erstatter den lineære fase-rekkefølgen med «Universal»-lag (UA-0…UA-7+). Dette dokumentet fikk
aldri en tilsvarende UA-N-omskrivning før nå (logget som D-37 i DECISIONS_AND_ASSUMPTIONS.md) — status
og evidens for UA-0/UA-1/D-30 finnes i [PROJECT_STATUS.md](PROJECT_STATUS.md) og
[RUNTIME_GATES.md](RUNTIME_GATES.md), ikke som egne seksjoner her, siden de allerede er lukket:

- **UA-0 – Core Runtime** (identitet, policy/D-class, minne-fundament, Model Gateway P0, Tool Gateway,
  worker/sandbox, owner-kontroller) = **VERIFIED** (BO-08, dekker mesteparten av fase 1–4/6).
- **UA-1 – Universal AI Mesh** (provider-agnostisk ruting, streaming, tool-calling, fallback) =
  **P0/LIVE/P1A VERIFIED** (BO-08/BO-10/BO-11, dekker fase 3s modellstrategi videre enn v2.1 planla).
- **D-30 Voice** (≈ fase 5s vertikale talepilot) = **VERIFIED** (BO-12, host-runde 6, 2026-08-14) —
  funksjonell korrekthet bevist; formell providerbenchmark (D-10) og realtime-latensmål (Q-19) er egne,
  ikke-blokkerende porter, ikke en del av D-30s korrekthetsscope.

Nye faser fra og med UA-2 spesifiseres under i samme format som fase-seksjonene over (Formål/
Avgrensning/Komponenter/Avhengigheter/Leveranser/Tester/Akseptansekriterier/Bygges IKKE), men med
UA-N-navn. Fase 6/7/8/9/10 sine ubygde deler (workers utover D-32-porten, øvrige integrasjoner utover
første bølge, mobil/Watch utover D-36-porten, HA, drift) videreføres uendret som egne porter og
kolliderer ikke med UA-2+ - de kan bygges i den rekkefølgen eier bestemmer.

---

## UA-2 – Universal Knowledge Layer (5–8 uker, masterplan v4.0) = VERIFIED/COMPLETE
(2026-08-17, masterplan-closeout-audit → D-48 i DECISIONS_AND_ASSUMPTIONS.md - hele fasen, ikke bare
enkeltdelfasene). Alle fire av masterplanens EGNE akseptansekriterier (linje 455-459 i
`docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md`, gjengitt ordrett under) er verifisert
PASS mot faktisk repo-evidens: fem uavhengige kildesystemer i samme retrieval-flyt (`filesystem`/
`github`/`google_drive`/`obsidian`/`email_attachment`), full provenance på hvert retrieval-resultat,
cross-tenant-lekkasje=0 (RLS + Q-20/Q-21, LIVE-bevist på tvers av P0/P1A/P1B-A), DPIA oppdatert for
alle nye datakategorier. Se PROJECT_STATUS.md sin "UA-2 MASTERPLAN CLOSEOUT"-seksjon for full
akseptansematrise. P0/P1A/P1B-A forblir egne, uendrede delfase-lukkinger (D-39/D-42/D-47).

**Mål:** Gjøre relevant kunnskap søkbar gjennom ETT Jarvis-grensesnitt, med kildeangivelse (provenance),
ferskhet (freshness) og tillit (trust) på alt som hentes ut — aldri en «sannhet» uten sporbar kilde.

**Avgrensning:** Retrieval og indeksering av eksisterende kunnskap i kildesystemer Tobias allerede
bruker — IKKE en ny generell dokumentdatabase, IKKE eierskap til systems-of-record-data (kalender/
e-post/CRM forblir live-referert, ikke kopiert som "sannhet" i Jarvis Memory).

**Komponenter (full masterplan-scope — se "Bygges IKKE" for hva som er UA-2 P0 vs. senere):**
- Kildeadaptere bak felles `KnowledgeSourceAdapter`-grense (speiler `ToolGateway`-mønsteret — ingen
  kildespesifikk logikk i Core): Obsidian (read/write/sync), Pieces (context bridge), Google
  Drive/Docs/Sheets/Slides (read/write/sync), NAS/lokale filer (read/write/watch), GitHub (utvider
  eksisterende `read_issues`), e-postvedlegg, møtetranskripsjoner.
- Inkrementell sync, dedupe, versjonering, sletting/tombstones (kilde slettes → Jarvis-kopi slettes/
  markeres tombstone, aldri stille foreldet data).
- Entity extraction + Knowledge Graph (utsettes til UA-2 P1 — se Q-10 i OPEN_QUESTIONS.md: «Trenger
  relasjonslaget egen grafdatabase?» avgjøres først etter målt behov, ikke antatt).
- FTS + vector retrieval (utvider eksisterende `pgvector`/`MemoryRetriever`-fundament fra fase 4/D-28 —
  IKKE en ny retrieval-stack).
- Live references for system-of-record-data (kalender/e-post hentes fersk via eksisterende Tool
  Gateway-adaptere ved spørring); permanent Jarvis Memory kun når varig verdi finnes (samme prinsipp
  som MEMORY_ARCHITECTURE.md allerede definerer for tekst/tale).

**Avhengigheter:** UA-0 (identitet/tenancy/policy/minne-fundament, VERIFIED), UA-1 (Model Gateway for
embeddings/ekstraksjon, VERIFIED), Tool Gateway (adaptergrense og Policy/Execution Authority, VERIFIED).

**Leveranser (full scope):** Kunnskap fra minst fem kildesystemer søkbar i samme retrieval-flyt med
kilde/ferskhet/tillit synlig; oppdatert DPIA/processing-inventory for hver nye datakategori.

**Tester:** Ingestion→retrieval ende-til-ende per kilde; sletting i kilde propagerer til tombstone i
Jarvis; cross-tenant/cross-memory-space-lekkasje = 0 (RLS-bevis, samme mønster som UA-0); freshness/
provenance-felt til stede på alle retrieval-resultater; dedupe hindrer duplikat-innhold ved re-sync.

**Akseptansekriterier (masterplan, full scope):**
1. Minst fem kildesystemer i samme retrieval-flyt.
2. All hentet kunnskap har kilde-pointer/ferskhet/tillit.
3. Cross-tenant-lekkasje = 0; sletting/tilbakekalling propagerer.
4. DPIA/processing-inventory oppdatert for nye datakategorier.

**Bygges IKKE (denne runden / UA-2 P0):** Knowledge Graph/entity-graf (P1, avhenger av Q-10);
Obsidian/Pieces-adaptere (krever lokal Obsidian-vault/Pieces-installasjon på host — utsettes til P1
sammen med graf); Drive/Docs/Sheets/Slides (krever Google OAuth-utvidelse utover eksisterende
Calendar/Gmail-scopes — P1); møtetranskripsjon (avhenger av UA-7 Communications Hub sin
meeting-transcription, ikke bygget ennå — P1+); ≥5-kilde-akseptansekriteriet (P0 beviser KONTRAKTEN
med 1–2 kilder, skalering til fem er en egen, senere port). **UA-2 P0 er derfor et forslag til
FØRSTE byggbare skive, ikke hele UA-2** — se under.

### UA-2 P0 — Knowledge Ingestion Foundation = SUITE-VERIFIED (2026-08-14)

**Status: IMPLEMENTED + SUITE-VERIFIED. IKKE host/live-verifisert** (bygget i sky-container uten
Docker/GitHub-credentials - se RUNTIME_GATES.md for full evidens/gap-liste). Godkjent av Tobias som
første byggbare UA-2-skive; bygget i `modules/knowledge` (`@jarvis/knowledge`).

**Bygget:**
1. **Kilde-uavhengig `KnowledgeSource`-kontrakt** (`source.ts`): `KnowledgeRecord` med
   source_type/source_instance_id/external_id/canonical_uri/title/content/content_type/content_hash/
   modified_at/metadata - ingen credentials i kontrakten. Fremtidige kilder (Obsidian/Pieces/Drive/
   e-post/møter) kan implementeres uten redesign.
2. **`FilesystemKnowledgeSource`** - generell (IKKE NAS-spesifikk domenelogikk), allowlistet root,
   symlink-escape og path-traversal strukturelt umulig (realpath-verifisering før hver fil leses),
   tekstformater (.md/.txt/.json/.yaml/.ts/.js/.py/.sql/.html/.css).
3. **`GithubKnowledgeSource`** - repo-metadata (ny `read_repo_meta`-action, samme PAT/scope som
   `read_issues`) + issues, via EKSISTERENDE `ToolGateway` (samme policy/audit/credential-vei som
   `daily-brief.ts`). Repo-FIL-innhold er IKKE bygget (dokumentert P1-utvidelse - transporten støtter
   det ikke uten en større connector-endring).
4. **`KnowledgeSyncService`** - idempotent sync (scanned/created/updated/unchanged/tombstoned/
   reactivated/failed-rapport), canonical identity + content_hash-dedupe, tombstone ved forsvunnet
   kilde (myk sletting - aldri hard-delete), deterministisk reaktivering ved gjenoppdukking, INGEN
   re-embedding ved uendret innhold.
5. **`KnowledgeRetriever`** - FTS + vector hybrid (samme pgvector/`cosine_sim`-fundament som
   `MemoryRetriever`, D-28), tombstonede dokumenter alltid filtrert bort, full provenance på hvert
   resultat.
6. **Storage:** migrasjon `017_knowledge.sql` - `knowledge_documents`/`knowledge_embeddings`, SAMME
   RLS-mønster som `memory_items` (tenant_id OG memory_space_id håndhevet i databasen), betinget
   pgvector-konvertering (samme mønster som D-28).
7. **DPIA/data-governance-notat:** `docs/UA2_KNOWLEDGE_DPIA.md`.

**Suite-verifisert (294/294 - se kvalitetsrapport i RUNTIME_GATES.md):** hele
livssyklusen (ingest→uendret resync→endring→sletting→reaktivering) mot ekte embedded Postgres + ekte
filsystem-I/O; tenant-isolasjon; memory-space-isolasjon; filsystem-allowlist/traversal/symlink-escape;
GitHub-kilde (fake transport - ingen live GitHub-credential i byggemiljøet); FTS-treff; vektor-likhet;
hybrid-rangering med provenance; ingen re-embedding ved uendret innhold.

**IKKE host/live-verifisert (§13 - krever Docker/ekte GitHub-PAT/ekte NAS-mount på Tobias sin host):**
faktisk NAS-mount som root, ekte GitHub-repo-sync med reell PAT, ende-til-ende-demo på hosten
(ingest→query→endre→resync→se ny versjon→slett→resync→se borte).

**Bygges IKKE i P0 (uendret fra forslaget):** skriving tilbake til kildene (read-only), Knowledge
Graph, Obsidian/Pieces/Drive/møtetranskripsjon, OCR/vision, autonom web-crawling, UA-3-forretningslogikk,
voice-ytelsesarbeid, UI for kunnskapssøk utover eksisterende `/chat`.

**Kjente åpne gap (ikke skjult - se OPEN_QUESTIONS.md):** Q-20 (kun myk sletting, ingen GDPR-
purge-vei ennå).

**UA-2 P1A — Knowledge Source Expansion (Google Drive full read/write + Obsidian) = VERIFIED/COMPLETE**
(host-bevist 2026-08-16, run_id `2703299e` - se D-42/D-41 i DECISIONS_AND_ASSUMPTIONS.md og
RUNTIME_GATES.md for full evidens). Eneste gjenværende utsatte punkt: Drive permission-mutasjon
live-host-bevis (Q-23, egen fremtidig test-runde med reell ekstern testkonto).

### UA-2 P1B-A — E-post-vedlegg + OCR/vision-ingestion-fundament = VERIFIED/COMPLETE
(host-bevist 2026-08-17, run_id `0f43f39d` - se D-47/D-45/D-46 i DECISIONS_AND_ASSUMPTIONS.md og
PROJECT_STATUS.md sin "UA-2 P1B-A FINAL CLOSURE"-seksjon for full evidens). Eneste gjenværende
utsatte punkt: P1B-A sin `knowledge-ingest-email`-worker-JOBB-live-kjøring (i motsetning til den
direkte `KnowledgeSyncService.sync()`-kjøringen host-scriptet selv bruker) er IKKE live-host-bevist
(ny, smal Q-24-gjenstand, samme mønster som Q-23 sitt Drive-permission-unntak).

**Status (historisk, ved implementering): IMPLEMENTED + SUITE-VERIFIED** (se D-43/D-44 i
DECISIONS_AND_ASSUMPTIONS.md, Q-24 i OPEN_QUESTIONS.md, RUNTIME_GATES.md). Bygget PÅ det VERIFIED
P0/P1A-fundamentet - ingen parallell ingestion-pipeline, ingen ny autentiseringsvei
(`JARVIS_EMAIL_TOKEN`, EGEN credential fra Drive/Calendar, se D-35).

**Bygget:**
1. **Multimodalt innhold i AI Mesh** (`packages/provider-adapters/src/types.ts`): `ChatMessage.content`
   utvidet til `string | ContentPart[]` (bakoverkompatibel). EKTE bildestøtte KUN i Anthropic-adapteren
   denne runden (`capability-registry.ts` sitt `vision`-flagg korrigert til å reflektere dette faktisk,
   ikke aspirasjonelt).
2. **`GmailTransport`** fikk `list_messages` (full listing m/body-tekst + rekursiv MIME-tre-
   vedleggsgjenfinning) og `read_attachment` (nedlasting, URL-safe→standard base64-konvertering) -
   SAMME `JARVIS_EMAIL_TOKEN`-credential-vei som eksisterende `read_inbox`.
3. **`extraction-safety.ts`** - deterministisk fil-type-klassifisering (arkiver/docx/xlsx/pptx
   EKSPLISITT avvist, aldri åpnet/utpakket), fail-closed størrelses-/side-/tidsgrenser,
   native→bilde-ekstraksjon-terskel, path-traversal-sikker filnavn-sanering.
4. **`OcrProvider`/`VisionDescriptionProvider`** (`ocr-provider.ts`) - `ModelGatewayVisionExtractor`
   ruter BEGGE tiers gjennom EKSISTERENDE `ModelGateway` (`purpose:"VISION"`, aldri en direkte
   leverandør-SDK). Dedikert lokal OCR-motor er EKSPLISITT UTSATT (D-43).
5. **`pdf-extraction.ts`** (`PdfExtractor`, ny avhengighet `pdf-parse` v2/`@napi-rs/canvas`, D-44) -
   ekte per-side native tekst-ekstraksjon OG side-rasterisering til bilde for OCR/vision-fallback.
6. **`EmailAttachmentKnowledgeSource`** - side-granulær "chunking" UTEN ny chunk-tabell
   (`external_id`-skjema `msg:<id>`/`att:<msgId>:<attId>`/`att:<msgId>:<attId>:page:<n>`, gjenbruker
   100% av eksisterende `KnowledgeSyncService`-dedupe/tombstone/Q-20/RLS), per-vedlegg/per-side
   feilisolasjon, AUTH/PERMISSION-eskalering (samme §15-mønster som Drive-kilden).
7. **Registry + durable worker**: `email_attachment`-kildetype i `KnowledgeSourceRegistry`, ny
   `knowledge-ingest-email`-agent-profil i `apps/api/src/worker-main.ts` (SAMME
   `InProcessWorker`/`PgTaskQueue` som `executive` - jobb-nivå checkpointing, ikke per-vedlegg).

**Suite-verifisert (813/813 - se kvalitetsrapport i RUNTIME_GATES.md):** multimodal content-mapping,
Gmail-transport-logikk (rekursiv MIME-tre, base64url-konvertering), fail-closed
sikkerhetsgrenser, deterministisk routing-beslutning, OCR→vision-fallback-kjede, EKTE PDF-ekstraksjon
(native tekst OG side-rasterisering, ikke mocket) mot håndlagde test-PDF-er, full
dedupe/tombstone/Q-20-resurrection-suppresjon-livssyklus mot ekte embedded Postgres, registry-/worker-
wiring.

**Host/live-verifisert (2026-08-17, run_id `0f43f39d`, se D-47):** ekte Gmail-listing/
vedleggsnedlasting, ekte vision-modellkall, full sync mot en ekte innboks (`scanned=5 created=5
failed=0`), Q-20-no-resurrection LIVE for e-post-kilden, `@napi-rs/canvas` sin native binær lastet
korrekt på Windows/Docker-hosten (tidligere kun dev-sandkasse-verifisert, D-44 - nå lukket).
**IKKE live-host-bevist (smalt, gjenværende, se Q-24):** selve `knowledge-ingest-email`-worker-JOBB-
kjøringen via `InProcessWorker`/`PgTaskQueue` (host-scriptet kaller `KnowledgeSyncService.sync()`
direkte) - kun implementasjon-/strukturelt suite-verifisert.

**Bygges IKKE i P1B-A (uendret fra forslaget):** møtetranskripsjon (avhenger av UA-7 Communications
Hub, ikke bygget), Pieces (Q-22), dedikert lokal OCR-motor, ekte bildestøtte i andre providere enn
Anthropic, docx/xlsx/pptx, per-vedlegg-checkpointing internt i én sync-kjøring.

**Kjente åpne gap (ikke skjult - se OPEN_QUESTIONS.md):** Q-24 (samlet gap-liste for P1B-A).

## UA-3 – Business Operating System (masterplan v4.0)

**Kanonisk kilde:** `docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md` linje 460-472 (ordrett).

**Mål:** Jarvis blir en OPERASJONELL LAG for forretningsdrift - ikke en frittstående CRM-silo. Gjenbruker
identitet/tenant-modell/minne/Knowledge/ToolGateway/Model Gateway/durable workers/Policy Gateway/audit/
events/tasks/integrasjoner/eier-sovereign-policy/D-41-connector-invariant uendret.

**Avgrensning:** Strukturert forretnings-state (selskap/kontakt/lead/opportunity/aktivitet/oppfoelging)
og spørringer over den - IKKE en generell ERP, IKKE full telefoni, IKKE Jarvis-dashboardet/control-
center (separat, senere plan), IKKE møtetranskripsjon.

**Komponenter (full masterplan-scope - se "Bygges IKKE" for P0 vs. senere):**
- Business Graph: person, selskap, lead, samtale, møte, tilbud, kontrakt, faktura, inntekt.
- CRM/pipeline, kundelivssyklus, kommunikasjonslenking, produktbruk, churn, support, oppgaver, vendors.
- Daglig/ukentlig business brief og automatisk open-loop-deteksjon.
- Identitet/tenant-modell støtter flere selskaper uten å blande kontoer/credentials/finansiell state
  (ALLEREDE arkitektonisk løst, se D-21/`docs/security/TENANT_MODEL.md` §3 - ingen skjemaendring krevd).

**Avhengigheter:** UA-0 (identitet/tenancy/policy/minne, VERIFIED), UA-1 (Model Gateway, VERIFIED), UA-2
(Knowledge, VERIFIED/COMPLETE - Business OS bruker Knowledge via referanse, kopierer aldri innhold),
Tool Gateway (adaptergrense, VERIFIED).

**Leveranser (full scope):** "Hva skjer med kunde X?" gir komplett, kilde-forankret tidslinje; "Hvordan
går bedriften?" kombinerer sales/product/finance/marketing/operations; open loops oppdages automatisk;
profiling/scoring med dokumenterte juridiske/menneskelige kontroller der påkrevd.

**Tester:** Tenant-isolert entitets-opprettelse; lead/opportunity-livssyklus; idempotent
hendelse-ingestion; aktivitetstidslinje; oppfoelging-livssyklus; forfalt-spørring; kilde-peker-lenking;
cross-tenant-tilgang nektet; memory-space-isolasjon; audit uten sensitivt innhold; owner sovereign
policy; delegert policy trygg.

**Akseptansekriterier (masterplan, full scope, linje 468-472 ordrett):**
1. "Hva skjer med kunde X?" gir complete source-backed timeline.
2. "Hvordan går bedriften?" kombinerer sales, product, finance, marketing, operations.
3. Open loops detected automatically.
4. Profiling/scoring used with documented legal/human controls where required.

**Bygges IKKE (denne runden / UA-3 P0):** Gmail/Calendar-hendelseslenking (Q-25); AI Mesh-basert
klassifisering/scoring/attention-queue (Q-25); worker/jobbkø-integrasjon for business-hendelser (Q-25);
kontrakt/faktura/inntekt-sporing (naturlig hjemme i en fremtidig UA-6, Q-25); numerisk lead/deal-scoring
(Q-25); D-klasse/hard-delete for business-entiteter (Q-25); proaktiv attention-queue/automatisk handling
(Q-25); UI/dashboard (separat, senere plan); full telefoni; møtetranskripsjon (avhenger av UA-7, ikke
bygget). **UA-3 P0 er derfor et forslag til FØRSTE byggbare skive, ikke hele UA-3** - se under.
**Automatisk open-loop-deteksjon + daglig/ukentlig business brief er NÅ bygget som UA-3 NEXT SLICE
(D-53, se under) - FJERNET fra "Bygges IKKE"-listen, men FORTSATT KUN FIXED_SUITE/READY_FOR_HOST_VERIFY,
IKKE VERIFIED, før Tobias sin host-kjøring.**

### UA-3 P0 — Business Domain Foundation = VERIFIED/COMPLETE (2026-08-17, host-bevist run_id `ca2d9248`)

**Status: VERIFIED/COMPLETE → D-52** (host-bevist av Tobias på ekte Windows/Docker-host - se
RUNTIME_GATES.md for full evidens). **Kun P0 er VERIFIED - resten av UA-3 er IKKE komplett** (se
Q-25), og masterplan v4.0 som helhet er IKKE komplett. Navngitt/prioritert fra masterplanens egen
integrasjons-prioritetstabell ("Internal CRM / Sales pipeline full internal UA-3 P0", linje ~1069) -
ingen oppfunnet struktur, se D-49 for full begrunnelse. Bygget i `modules/business` (`@jarvis/business`).
**HOST FIX #1 (samme dag, D-50):** Tobias sin første host-kjøring (`run_id b95dd25f`) avdekket at
`ua3-business-live.ts` feilaktig brukte runtime-poolen til å opprette akseptanse-scaffolding (`42501`
RLS-avslag mot `tenants` - RLS fungerte som tiltenkt, ikke en feil å svekke) - fikset med en egen
`adminPool` for scaffold/cleanup, se D-50 for full detalj.
**HOST FIX #2 (samme dag, D-51):** ANDRE host-kjøring (`run_id ad45603d`) kom HELE VEIEN gjennom OG
**alle 13 faktiske Business OS-kapabilitetstester PASSET** - kun akseptanse-CLEANUP feilet
(append-only `audit_events`-trigger-kast stoppet resten av `cleanupTenant()`, som deretter fikk
`DELETE FROM people` til å feile med `person_tenants_person_id_fkey`) - fikset ved å fjerne
`DELETE FROM audit_events` helt fra cleanup (append-only er tiltenkt, ikke en feil), se D-51.

**Bygget:**
1. **Business Graph-domenemodell** (`019_business.sql`) - 6 nye, tenant-scoped FORCE RLS-tabeller
   (`business_companies`/`business_contacts`/`business_leads`/`business_opportunities`/
   `business_activities`/`business_followups`), SAMME RLS-mønster som `knowledge_documents`
   (017_knowledge.sql). Idempotent kilde-ingestion via `UNIQUE(tenant_id, source_type,
   source_instance_id, external_id)` (leads/aktiviteter) og `idempotency_key` (followups).
2. **`BusinessService`** (`service.ts`) - gjenbruker `withMemoryTransaction` fra `@jarvis/memory`
   uendret; CRUD/livssyklus for alle 6 entiteter, kunde-tidslinje, forfalt-oppfoelging-spørring,
   grunnleggende drifts-metrikker. Follow-ups er en VANLIG relasjonstabell, IKKE rutet via
   `PgTaskQueue`/`tasks`-jobbkøen (den er for agent-jobbkjøring, ikke menneske-vendte TODO-er).
3. **`BusinessTransport implements ToolTransport`** - ruter 13 ToolGateway-handlinger til
   `BusinessService`, klassifisert A (5 reads)/B (5 enkle reversible writes)/C (3 tilstandsoverganger),
   INGEN D-klasse. `BusinessInternalSecretProvider` løser credential-kravet for et rent internt verktøy
   (ikke-hemmelig sentinel, wiret via EKSISTERENDE `FallbackSecretProvider`-primitiv).
4. **ToolGateway-registrering** - `business`-nøkkelen lagt til som femte, ubetinget konstruert
   transport i `firstWaveTools({...})` i `main.ts`/`worker-main.ts`, samme mønster som
   email/calendar/github/telegram.

**Suite-verifisert (930/930 - 44 nye tester totalt, se kvalitetsrapport i RUNTIME_GATES.md):**
tenant-isolert entitets-opprettelse, lead/opportunity-livssyklus, idempotent lead/aktivitet-ingestion,
aktivitetstidslinje, oppfoelging-livssyklus (create/complete/cancel/overdue), kilde-peker-lenking
(canonical_uri, ingen FK til knowledge_documents - strukturelt Q-20-trygt), cross-tenant/memory-space-
isolasjon (RLS mot ekte embedded Postgres), samtidig idempotency_key-sikkerhet, ToolGateway-wiring
(owner sovereign + delegert policy, EKSISTERENDE PolicyGateway-mekanikk, ingen ny logikk), audit-
metadata uten sensitivt kundeinnhold, scaffold-/runtime-pool-separasjon + append-only-audit-trygg
FK-korrekt CLEANUP (inkl. LIVE reproduksjon av BÅDE `42501`-RLS-avslaget og
`person_tenants_person_id_fkey`-bruddet host-kjøringene traff, mot ekte embedded Postgres).

**Host/live-verifisert (2026-08-17, run_id `ca2d9248`, se D-52):** ETT Windows host-akseptanseskript
(`modules/business/scripts/ua3-host-run.ts` → `ua3-business-live.ts`, speiler
`q20-host-run.ts`/`q20-erasure-live.ts`-mønsteret) kjørt TRE ganger av Tobias: (1) `run_id
b95dd25f` - feilet på scaffold-bug FØR Business OS-kapabilitetene ble evaluert (D-50); (2) `run_id
ad45603d` - kom gjennom bootstrap/migrasjoner/Q-21 OG alle 13 Business OS-kapabilitetstester PASSET,
kun CLEANUP feilet (D-51); (3) `run_id ca2d9248` - HELE VEIEN gjennom, alle 13 kapabilitetsmarkører
OG alle 5 CLEANUP-markører PASS, `hard_fail=false`, ingen nye funn.

**Bygges IKKE i P0 (uendret fra "Bygges IKKE" over):** se Q-25 for full liste.

**Kjente åpne gap (ikke skjult - se OPEN_QUESTIONS.md):** Q-25 (samlet deferred-liste for UA-3 P0).

### UA-3 NEXT SLICE — Open-Loop Detection + Daily/Weekly Business Brief = FIXED_SUITE / READY_FOR_HOST_VERIFY (2026-08-17) → D-53

**Status: FIXED_SUITE / READY_FOR_HOST_VERIFY. IKKE VERIFIED, IKKE host-kjørt, IKKE merget.** Bygget PÅ
det VERIFIED/COMPLETE P0-fundamentet, additiv migrasjon. Retter seg direkte mot masterplanens
akseptansekriterium 3 ("Open loops detected automatically") og den navngitte "Bygges"-listen ("Daily/
weekly business brief og open-loop detection", linje 543/463-467) - VERIFISERT mot canonical tekst FØR
bygging (§0 canonical scope-audit, ingen konflikt med UA-3 P1-connector-radene, se D-53 for full
begrunnelse).

**Bygget:**
1. **`business_open_loops`** (`020_business_open_loops.sql`, additiv) - SAMME FORCE RLS-mønster som
   de 6 P0-tabellene. `detection_key` (UNIQUE per tenant) er idempotens-nøkkelen.
2. **`OpenLoopService`** (`open-loop-service.ts`) - to deterministiske regler
   (`detectOverdueFollowups`/`detectStalledOpportunities`), idempotent upsert, auto-resolve når
   vilkåret ikke lenger er sant, gjenåpning på samme rad, deterministisk prioritet,
   `attentionQueue()`-bucketing. **Ingen AI Mesh-bruk** - begge regler er utvetydige.
3. **`business-brief.ts`** - DAGLIG gjenbruker `DailyBrief`-motoren uendret (ny `businessOpenLoopsSource`);
   UKENTLIG (`generateWeeklyBrief`) er en egen, liten, kilde-forankret aggregeringsfunksjon.
   `BUSINESS_DOMAIN_COVERAGE` markerer EKSPLISITT kun `sales` tilgjengelig - de fire andre domenene
   `not_integrated` (akseptansekriterium 2 fortsatt IKKE fullt oppfylt, ærlig rapportert).
4. **`open-loop-sweep.ts`** - periodisk sveip via EKSISTERENDE `DailyScheduler` (eget job_name), wiret
   inn i `main.ts`/`worker-main.ts` uavhengig av Telegram-konfig.
5. **`BusinessTransport`** utvidet med 8 nye ToolGateway-handlinger (4×A, 2×C, 2×B, INGEN D).
6. **Host-akseptanseskript** `ua3-open-loops-host-run.ts` → `ua3-open-loops-live.ts`, speiler P0 sin
   bevist-korrekte admin-/runtime-pool-separasjon (HOST FIX #1) og append-only-audit-trygge CLEANUP-
   rekkefølge (HOST FIX #2).

**Suite-verifisert (52 nye tester, se D-53/RUNTIME_GATES.md):** forfalt-oppfoelging/stagnert-
opportunity-deteksjon, idempotens, resolusjon (manuell + auto), gjenåpning, prioritet, kilde-forankret
begrunnelse, tenant-/space-isolasjon, attention-queue-bucketing, defer/assign/set-next-action,
Q-20-interaksjon (ingen FK til knowledge_documents), FORCE RLS bekreftet i databasen, ingen direkte AI
Mesh/provider-import, brief-innhold + domenedeknings-ærlighet, ToolGateway-wiring gjennom EKSISTERENDE
Policy Gateway, sveip-hjelperens tenant-scoping/bounded-LIMIT/feilisolasjon.

**Bygges IKKE i denne sliceen:** Support/tickets- og Contracts/e-sign-connectorer (forblir UA-3
P1-connector-kandidater); Gmail/Calendar-hendelseslenking; full tverr-domene bedriftshelse; numerisk
lead/deal-scoring; D-klasse/hard-delete; UI/dashboard; AI Mesh-basert semantisk tolkning (ingen
ambiguitet krevde det).

**Kjente åpne gap (ikke skjult - se OPEN_QUESTIONS.md):** Q-25 (oppdatert deferred-liste for HELE UA-3,
inkl. det som fortsatt gjenstår etter denne sliceen).

---

## Fase-avhengigheter (oversikt)

```
F1 → F2 → F3 → F4 ─────────┐
             │             ├→ F7 → F8
             ├→ F5 ────────┤       F9
             └→ F6 ────────┘
F10: kontinuerlig etter F3, fullføres etter F7
```

## Teknologistack (foreslått – godkjennes med fase 1)

| Område | Valg | Begrunnelse |
|---|---|---|
| Språk (Core/Worker/web) | TypeScript, Node 22, pnpm monorepo | Ett språk + delte typede kontrakter; sterkt økosystem for streaming/API; passer Claude Code-drevet utvikling (D-14) |
| Web | Next.js (kun webchat) | Rask å bygge, streaming-støtte; ingen Vercel-avhengighet for drift |
| Database | PostgreSQL 16 i Docker: RLS + pgvector + tsvector + pgmq | Ett systemkrav dekker strukturert+fulltekst+vektor+kø; flytter uendret lokal↔server↔Supabase (D-12) |
| Kø/workflow | pg-boss-klasse over Postgres bak `WorkflowAdapter`; Trigger.dev/Hatchet evalueres i fase 6 | Lokal-først uten skyavhengighet; adapter gjør bytte billig (D-13) |
| Model Gateway | Egne TS-adaptere (Anthropic/OpenAI/OpenRouter/Ollama); LiteLLM-proxy som container vurderes i fase 3 hvis egenkoden vokser | Unngår Python-avhengighet i kjernen; Jarvis-spesifikk ruting er uansett egen kode (K-04) |
| Tale | Egen gateway-prosess; WebRTC (LiveKit selvhostet som kandidat); STT/TTS bak `SpeechAdapter`, valg via norsk benchmark | Full-duplex-krav; leverandøruavhengighet; måling før låsing (D-10) |
| Observability | Langfuse selvhostet + OpenTelemetry + strukturert JSON-logg | Masterplanens valg; selvhostet = lokal-først |
| Secrets | SOPS + age (fase 1, ingen kjørende vault) → sentral vault senest fase 7 (valg per Q-05) | Gradvis: aldri secrets i kode fra dag én, vault når flere prosesser deler (D-16) |
| Sandbox | Docker på WSL2; kastbar container per jobb | Kravet i masterplanen; kjører på PC-en (RTX 4070) som utviklings-/GPU-worker (D-20; K-06 følges opp) |
| CI | GitHub Actions: lint, typecheck, test, gitleaks, policytester, minne-eval | Alle porter automatiseres |
| Mobil | Swift/SwiftUI + watchOS (fase 8) | Apple-økosystem er kravet (A-05) |

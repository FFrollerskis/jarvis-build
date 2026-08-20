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
**Automatisk open-loop-deteksjon + daglig/ukentlig business brief er NÅ bygget OG VERIFIED/COMPLETE
(D-53/D-54/D-55/D-56, se under) - FJERNET fra "Bygges IKKE"-listen, host-bevist på ekte Windows/Docker-
host (run_id `de01ca07`, `hard_fail=false`).**
**Gmail/Calendar-hendelseslenking er NÅ BYGGET, men IKKE ennå host-verifisert (D-57, se under)** -
status FIXED_SUITE / READY_FOR_HOST_VERIFY, FJERNET fra den gjenværende deferred-listen i Q-25 sitt
tidligere item 1.

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

### UA-3 — Open-Loop Detection + Daily/Weekly Business Brief = VERIFIED/COMPLETE (2026-08-17, host-bevist run_id `de01ca07`) → D-53/D-54/D-55/D-56

**Status: VERIFIED/COMPLETE → D-56** (host-bevist av Tobias på ekte Windows/Docker-host etter tre
host-runder - se RUNTIME_GATES.md for full evidens). Bygget PÅ det VERIFIED/COMPLETE P0-fundamentet,
additiv migrasjon. Retter seg direkte mot masterplanens akseptansekriterium 3 ("Open loops detected
automatically") og den navngitte "Bygges"-listen ("Daily/weekly business brief og open-loop
detection", linje 543/463-467) - VERIFISERT mot canonical tekst FØR bygging (§0 canonical
scope-audit, ingen konflikt med UA-3 P1-connector-radene, se D-53 for full begrunnelse). **Kun denne
sliceen + P0 er VERIFIED - resten av UA-3 er IKKE komplett** (se Q-25), og masterplan v4.0 som helhet
er IKKE komplett. PR #10 merget til `main`.

**HOST FIX #1 (samme dag, D-54):** Tobias sin første host-kjøring (`run_id 19a7f3a4`) viste 12/14
kapabilitetsmarkører PASS - idempotens-akseptansen feilet på en RLS-blind harness-spørring (raw
`pool.query()` uten `withMemoryTransaction` mot en FORCE-RLS-tabell - IKKE en produksjonsfeil), og
CLEANUP feilet på et nytt `cost_events`-FK-funn (`get_business_brief` sin `DailyBrief`-bruk skriver
en cost_events-rad P0 aldri traff). Begge fikset uten å røre produksjonslogikk.

**HOST FIX #2 (samme dag, D-55):** ANDRE host-kjøring (`run_id c7fe8206`) bekreftet begge D-54-fikser
PASS live, men CLEANUP feilet PÅ NYTT med et uavhengig `brief_seen`-FK-funn (samme
`DailyBrief.generate({pool})`-kodeblokk som cost_events, en annen INSERT). Fikset med en dynamisk,
skjema-drevet selvdiagnostisk FK-sperre (`findBlockingTenantDependencies()`) som fanger fremtidige
ukjente avhengigheter automatisk FØR `DELETE FROM tenants` forsøkes.

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

**Suite-verifisert (1010/1010 tester totalt, 80 nye over hele sliceen inkl. begge host-fixene - se
RUNTIME_GATES.md):** forfalt-oppfoelging/stagnert-opportunity-deteksjon, idempotens, resolusjon
(manuell + auto), gjenåpning, prioritet, kilde-forankret begrunnelse, tenant-/space-isolasjon,
attention-queue-bucketing, defer/assign/set-next-action, Q-20-interaksjon (ingen FK til
knowledge_documents), FORCE RLS bekreftet i databasen, ingen direkte AI Mesh/provider-import,
brief-innhold + domenedeknings-ærlighet, ToolGateway-wiring gjennom EKSISTERENDE Policy Gateway,
sveip-hjelperens tenant-scoping/bounded-LIMIT/feilisolasjon, `cost_events`/`brief_seen`-FK-sikker
cleanup, dynamisk skjema-drevet FK-blokkerings-diagnostikk.

**Host/live-verifisert (2026-08-17, run_id `de01ca07`, se D-56):** ETT Windows host-akseptanseskript
(`ua3-open-loops-host-run.ts` → `ua3-open-loops-live.ts`) kjørt TRE ganger av Tobias: (1) `run_id
19a7f3a4` - 12/14 kapabilitetsmarkører PASS, idempotens-harness + CLEANUP feilet (D-54); (2) `run_id
c7fe8206` - begge D-54-fikser bekreftet, CLEANUP feilet på nytt (D-55); (3) `run_id de01ca07` - HELE
VEIEN gjennom, alle 16 markører PASS, `hard_fail=false`, ingen nye funn.

**Bygges IKKE i denne sliceen:** Support/tickets- og Contracts/e-sign-connectorer (forblir UA-3
P1-connector-kandidater); Gmail/Calendar-hendelseslenking; full tverr-domene bedriftshelse; numerisk
lead/deal-scoring; D-klasse/hard-delete; UI/dashboard; AI Mesh-basert semantisk tolkning (ingen
ambiguitet krevde det).

**Kjente åpne gap (ikke skjult - se OPEN_QUESTIONS.md):** Q-25 (oppdatert deferred-liste for HELE UA-3,
inkl. det som fortsatt gjenstår etter denne sliceen).

### UA-3 — Business-Event-Linkage (Gmail/Calendar → Business OS) = VERIFIED/COMPLETE (2026-08-17) → D-57/D-58/D-59/D-60

**Status: VERIFIED/COMPLETE → D-60**, host-bevist av Tobias på ekte Windows/Docker-host (run_id
`6c6a4948`, `hard_fail=false`). HOST FIX #1 (D-58) rettet en credential-provider-bug (første
host-forsøk, `run_id 7c5a5289`). HOST FIX #2 (D-59) rettet en RLS-blind audit-verifikasjonsspørring
(andre host-forsøk, `run_id b969e9e7` - ALL funksjonell kapabilitet allerede LIVE-bevist da). TREDJE
host-forsøk (`run_id 6c6a4948`) kom HELE VEIEN gjennom, alle markører PASS, ingen nye funn. Bygget PÅ
det VERIFIED/COMPLETE open-loop-fundamentet (D-56), additiv migrasjon. **KUN denne sliceen er
VERIFIED - HELE UA-3 er FORTSATT IKKE komplett**, se D-60 sin firekriterie-akseptansematrise og
oppdatert Q-25.
Canonical-audit (§1-§5 i byggeordren) bekreftet at UA-3 sine gjenværende P1-connector-kandidater
("Support/tickets", "Contracts/e-sign", masterplan linje 1070-1071) IKKE har en navngitt leverandør noe
sted i canonical dokumenter - å velge én ville brutt ordrens eksplisitte provider-beslutnings-gate.
Gmail/Calendar er derimot allerede provider-besluttede UA-0/UA-7-P0-connectorer (linje 1101-1102) - den
ENESTE måten å levere UA-3 sitt FØRSTE akseptansekriterium ("Hva skjer med kunde X?", linje 469) uten å
oppfinne en leverandørbeslutning. Se D-57 for full canonical-audit-begrunnelse.

**Bygget:**
1. **`GmailTransport.listMessages()`** utvidet med `to`/`cc`-headere (additivt felt, ingen breaking
   endring for eksisterende `EmailAttachmentKnowledgeSource`-forbruker).
2. **`GoogleCalendarTransport`** fikk en NY `list_events`-handling (deltaker-e-poster + `html_link`) -
   `read_events` (personlig daily brief) er UENDRET, samme separasjons-mønster som Gmail sin
   `read_inbox`/`list_messages`-splitt (D-43).
3. **`BusinessEventSyncService`** (`business-event-sync.ts`) - deterministisk entitetsgjenkjenning
   (`extractCounterpartEmails`/`findContactsByEmail`, INGEN AI Mesh), idempotent aktivitets-registrering
   via EKSISTERENDE `recordActivity()`-mekanisme, `syncTenant()` kaller `OpenLoopService.runSweep()`
   uendret etter hver synk.
4. **`BusinessService.findContactsByEmail()`** - ny metode, case-insensitiv, additiv indeks
   (`021_business_contact_email_lookup.sql`).
5. **ToolGateway** - ny `calendar.list_events` (klasse A) og `business.sync_business_events` (klasse B,
   INGEN D). `BusinessTransport` fikk en fjerde, valgfri `toolGateway`-konstruktørparameter.
6. **Periodisk synk** via EKSISTERENDE `DailyScheduler` (`job_name="business-events-sync"`,
   `JARVIS_BUSINESS_EVENTS_SYNC_HOUR`, default kl. 05), wiret inn i `main.ts` (uendret i
   `worker-main.ts` utover selve `BusinessTransport`-konstruksjonen).
7. **Host-akseptanseskript** `ua3-business-events-host-run.ts` → `ua3-business-events-live.ts` - to-delt
   strategi (ekte connector-reachability + deterministisk FakeTransport-basert entitetsgjenkjenning),
   gjenbruker UENDRET D-55 sin selvdiagnostiske FK-blokkerings-sperre.

**Suite-verifisert (1071/1071 tester totalt, 61 nye over hele sliceen inkl. HOST FIX #1 - se
RUNTIME_GATES.md):** e-post-adresse-parsing, motpart-utledning (From/To/Cc), matchet/umatchet/tvetydig
entitetsgjenkjenning (Gmail OG Calendar), idempotens (re-synk gir ingen duplikat), ingen body-/
beskrivelses-innhold lagret (kun kilde-peker), tenant-/memory-space-isolasjon, open-loop-reevaluering,
ToolGateway-wiring (owner sovereign + delegert policy), audit-metadata uten sensitivt innhold, ingen
direkte fetch/provider-SDK/AI Mesh-bruk, EnvSecretProvider-credential-oppløsning, uavhengig
Gmail/Calendar-feilhåndtering, ingen credential-lekkasje.

**HOST FIX #1 (samme dag, D-58):** Tobias sin FØRSTE host-kjøring (`run_id 7c5a5289`) traff
`tool_failed:credential_unavailable` på REACHABILITY - rotårsak: akseptanseskriptets REACHABILITY-
seksjon brukte en alltid-null stub-secret-provider i stedet for den ekte `EnvSecretProvider()`
produksjonen selv bruker (ren harness-bug, produksjon uendret). Fikset + Gmail/Calendar rapporteres nå
uavhengig av hverandre (§9) + en urelatert, ekte race i `createFollowup()` (P0/D-49) funnet via CI
fikset samtidig. Se D-58 for full detalj.

**HOST FIX #2 (samme dag, D-59):** Tobias sin ANDRE host-kjøring (`run_id b969e9e7`) beviste ALLE
funksjonelle Business-Event-kapabiliteter LIVE (ekte Gmail `scanned=25`/Calendar-reachability,
matched/unmatched/ambiguous, idempotens, tenant-/space-isolasjon, open-loop-reevaluering, cleanup) -
KUN `ua3_events_audit_safe=FAIL` blokkerte. Rotårsak: SAMME feilklasse som D-54 - en RLS-blind raw
`pool.query()` mot `audit_events` (FORCE ROW LEVEL SECURITY), IKKE en produksjonsfeil (audit-skrivingen
skjer inni SAMME `withTenantTransaction` som selve verktøykjøringen). Fikset til `withTenantTransaction()`
(ren akseptanse-harness-fiks). Se D-59 for full detalj.

**HOST VERIFICATION (samme dag, D-60):** Tobias sin TREDJE host-kjøring (`run_id 6c6a4948`,
`hard_fail=false`) kom HELE VEIEN gjennom - alle markører PASS inkl. `ua3_events_audit_safe=PASS`
(`audit_event_found=true`), ingen nye funn. Slice-status oppgradert til VERIFIED/COMPLETE. Se D-60 for
full evidens, host-proven-kapabilitetsliste og re-evaluering av UA-3 sine fire akseptansekriterier
(kriterium 1 "Hva skjer med kunde X?" er KUN PARTIAL på full katalogbredde - Support/tickets og
Contracts/e-sign gjenstår, uavklart Tobias-provider-beslutning). PR #11 merget til `main`.

**Bygges IKKE i denne sliceen:** Support/tickets- og Contracts/e-sign-connectorer (krever fortsatt en
Tobias-provider-beslutning); AI Mesh-basert semantisk aktivitets-sammendrag (deterministisk emne-/
tittel-basert summary er tilstrekkelig for dette sliceet); event-/webhook-drevet synk (periodisk
`DailyScheduler`, ikke sanntid); sammenslått multi-tenant Gmail/Calendar-henting (per-tenant kall mot
samme konto - se Q-25 item 10); full tverr-domene bedriftshelse; numerisk lead/deal-scoring;
D-klasse/hard-delete; UI/dashboard.

**Kjente åpne gap (ikke skjult - se OPEN_QUESTIONS.md):** Q-25 (oppdatert deferred-liste for HELE UA-3,
inkl. det som fortsatt gjenstår etter denne sliceen).

### UA-3 — Profiling/Scoring (akseptansekriterium 4) = VERIFIED/COMPLETE (2026-08-17) → D-61/D-62/D-63

**Status: VERIFIED/COMPLETE → D-63**, host-bevist av Tobias på ekte Windows/Docker-host (run_id
`61b5cf63`, `hard_fail=false`). Bygget PÅ det VERIFIED/COMPLETE Business-Event-Linkage-fundamentet
(D-60). Canonical-audit
(§1 i byggeordren) bekreftet at akseptansekriterium 4 ("Profiling/scoring used with documented legal/
human controls where required", linje 472) var det eneste av UA-3 sine fire kriterier som IKKE krever en
uavklart leverandørbeslutning - Support/tickets og Contracts/e-sign forblir eksplisitt IKKE bygget denne
runden (krever fortsatt Tobias-provider-beslutning, se D-57/Q-25 item 8).

**Bygget:**
1. **Migrasjon `022_business_scoring.sql`** - ny `business_scores`-tabell, samme FORCE RLS
   tenant+memory_space-RESTRICTIVE-mønster som `business_open_loops` (020). `entity_type` er
   DB-CHECK-begrenset til `'lead'`/`'opportunity'` - kontakt-/person-scoring er strukturelt umulig.
2. **`scoring-rules.ts`** - REN, DB-uavhengig, 100% deterministisk regelmotor
   (`calculateLeadPriorityV1`/`calculateOpportunityRiskV1`), whitelist av tillatte faktor-koder
   (`ALLOWED_LEAD_FACTOR_CODES`/`ALLOWED_OPPORTUNITY_FACTOR_CODES`) + `assertNoProhibitedFactorCodes()`
   som strukturelt blokkerer enhver beskyttet-trekk-kode.
3. **`scoring-service.ts`** - signal-innsamling (KUN `business_leads`/`business_opportunities`/
   `business_activities`/`business_followups`/`business_open_loops` - ALDRI kontakt-/person-felter),
   idempotent UPSERT-persistering, `explainScore`/`rankLeads`/`rankOpportunities`,
   `setManualOverride`/`clearManualOverride` (rører aldri de underliggende beregnede faktorene).
4. **ToolGateway** - 8 nye `business.*`-handlinger (`get_lead_score`/`get_opportunity_score`/
   `explain_score`/`rank_leads`/`rank_opportunities` = klasse A; `recalculate_score`/
   `set_manual_override`/`clear_manual_override` = klasse B, INGEN klasse D). `BusinessTransport`
   fikk en femte, valgfri `ScoringService`-konstruktørparameter - fail-closed når ikke wiret inn.
5. **Periodisk rekalkulering** via EKSISTERENDE `DailyScheduler` (`job_name="business-scoring-recalc"`,
   `JARVIS_BUSINESS_SCORING_HOUR`, default kl. 07 - ETTER events-sync (05) og open-loop-sveipet (06)).
6. **Host-akseptanseskript** `ua3-profiling-scoring-host-run.ts` → `ua3-profiling-scoring-live.ts` -
   ETT-delt strategi (business-scoring har INGEN ekstern leverandør-credential, i motsetning til
   Gmail/Calendar-linkage sin to-delte REACHABILITY/FakeTransport-strategi), gjenbruker UENDRET D-55
   sin selvdiagnostiske FK-blokkerings-sperre.

**Suite-verifisert (1147/1147 tester totalt, 65 nye over hele sliceen - se RUNTIME_GATES.md):**
lead-/opportunity-score-beregning, faktor-forklaring, evidence/kilde-referanser, score-versjonering,
beskyttet-trekk-forbud (strukturelt OG funksjonelt bevist), ingen skjult personlighets-/trekk-inferens,
manuell overstyring + audit, idempotent rekalkulering, tenant-/memory-space-isolasjon, Q-21-rollesikkerhet,
ToolGateway-lesing/-skriving, audit-personvern, ingen AI Mesh-/ModelGateway-bruk, Q-20-kildefjerning-
resiliens, hoy-konsekvens-personbeslutning strukturelt umulig, fail-closed når ikke konfigurert.

**Bygges IKKE i denne sliceen:** kontakt-/person-nivå-scoring (arkitektonisk umulig, ikke bare utsatt);
AI Mesh-basert semantisk scoring (v1 er 100% deterministisk); finere per-tenant/policy-nivå av/på-bryter
utover konstruktør-wiring; event-drevet (ikke periodisk) rekalkulering; kontrakt-/faktura-verdi-baserte
faktorer (unngår arbitrære terskler); Support/tickets- og Contracts/e-sign-connectorer (krever fortsatt
en Tobias-provider-beslutning).

**HOST FIX #1 (samme dag, D-62):** Tobias sin FØRSTE host-kjøring (`run_id 22226237`) beviste ALLE
funksjonelle scoring-kapabiliteter LIVE - KUN `ua3_scoring_idempotent=FAIL` blokkerte. Rotårsak: SAMME
feilklasse som D-54/D-59 - IDEMPOTENS-spørringen brukte `withTenantTransaction()` (kun
`jarvis.tenant_id`) mot `business_scores`, som - i motsetning til `audit_events` - har en EKSTRA
RESTRICTIVE memory-space-policy. Fikset til `withMemoryTransaction()`, ren akseptanse-harness-fiks,
ingen produksjonskode rørt. Se D-62 for full detalj.

**HOST VERIFICATION (samme dag, D-63):** Tobias sin ANDRE host-kjøring (`run_id 61b5cf63`,
`hard_fail=false`) kom HELE VEIEN gjennom - alle 17 markører PASS inkl. `ua3_scoring_idempotent=PASS`
(`score_rows_for_same_identity=1`), ingen nye funn. Slice-status oppgradert til VERIFIED/COMPLETE.
**Akseptansekriterium 4 re-evaluert til COMPLETE/VERIFIED** - rettslig grunnlag (GDPR art. 6(1)(f))
lagt til `UA3_BUSINESS_DPIA.md`, GDPR art. 22 (automatiserte enkeltavgjørelser) eksplisitt vurdert og
funnet ikke relevant (en score verken produserer rettslige effekter eller tilsvarende betydelig
påvirker en person), menneskelig/juridisk kontroll (manuell overstyring + audit + full forklarbarhet)
likevel til stede og host-bevist. Se D-63 for full evidens og oppdatert firekriterie-akseptansematrise
(kriterium 3 og 4 nå COMPLETE/VERIFIED, kriterium 1 og 2 fortsatt PARTIAL). PR #12 merget til `main`.

**Kjente åpne gap (ikke skjult - se OPEN_QUESTIONS.md):** Q-25 (oppdatert deferred-liste for HELE UA-3).

---

### UA-3 — Native Jarvis Support Core (akseptansekriterium 1, Support/tickets) = VERIFIED/COMPLETE (2026-08-18) → D-66/D-67/D-68/D-69/D-70

**Status: VERIFIED/COMPLETE → D-70 (endelig lukking), host-bevist run_id `da7e0c1b`,
`hard_fail=false`, ALLE 26 markører PASS.** Opprinnelig bygget FIXED_SUITE under D-66 (se resten av
denne seksjonen for full byggedetalj), deretter tre host-funn-drevne fiks-runder (D-67 HOST FIX #1,
D-68 SECURITY FIX #2, D-69 HOST FIX #3 - se egne underseksjoner nederst) FØR den fjerde, rene
kjøringen som ga `hard_fail=false`. 98 nye tester totalt over hele slicen (1176→1268). Draft-PR #17
klar for review - **MERGES IKKE uten Tobias sin eksplisitte godkjenning.**
Implementerer D-64 sitt permanente Core Ownership-vedtak: Support/tickets-domenet skal være
`JARVIS_CANONICAL` (Jarvis eier selv ticket-lifecycle/domenemodellen), IKKE en ekstern SaaS-leverandør
(Zendesk/Intercom/Freshdesk) - den tidligere, ALDRI merget Zendesk-connectoren (draft-PR #13) forblir
SUPERSEDED/UNMERGED EXPERIMENTAL, en mulig fremtidig VALGFRI kanal-adapter, ALDRI domeneeier.

**D-64 Core-vs-Adapter-gate kjørt FØR kode:** CAPABILITY=kundesupport/ticket-håndtering;
JARVIS_CORE=lifecycle/operasjonell state/selskap-kontakt-kobling/events/tildeling/prioritet/SLA/
Business-OS-kobling/open-loops; EXTERNAL_ROLE=Gmail som kommunikasjonstransport (fremtidige eksterne
support-systemer KUN som valgfrie adaptere); SYSTEM_OF_RECORD=`JARVIS_CANONICAL`;
CAN_RUN_WITHOUT_PROVIDER=true (ZERO Zendesk-avhengighet, bevist mekanisk); D41_SCOPE=gjelder kun en
fremtidig ekstern adapter.

**Bygget:**
1. **Ny pakke `@jarvis/support`** + migrasjon `024_support.sql` - `support_tickets`
   (ticket-nummer/tenant/memory-space/selskap-kontakt-kobling/status/prioritet/ansvarlig/kanal/
   generiske `source_*`/`canonical_uri`-pekere/entitetsresolusjon/frister) + `support_ticket_events`
   (12 hendelsestyper, egen kunde-tidslinje, EKSPLISITT separat fra `audit_events`).
2. **Deterministisk lifecycle** (`state-machine.ts`) - explicit overgangskart, gjenåpning
   `resolved/closed → open` eksplisitt tillatt, ugyldig overgang kaster og endrer INGENTING.
3. **Kanal-nøytral domenemodell** (§6) - INGEN Gmail-spesifikke kolonner, kun generiske
   kilde-pekere - fremtidige kanaler krever ingen skjemaendring.
4. **Gmail-ingress** (`email-ingress.ts`) gjenbruker EKSISTERENDE `GmailTransport` - INGEN egen
   e-postklient. Deterministisk routing (konfigurert innboks ELLER kjent tråd-id) - AI er ALDRI
   eneste port.
5. **Idempotens** - samme provider-tråd → samme ticket, samme provider-melding → ETT event, SAMME
   `ON CONFLICT`-mønster som `business_activities`/`business_leads`.
6. **Entitetsresolusjon** gjenbruker `BusinessService.findContactsByEmail()` DIREKTE - samme MATCHED/
   UNMATCHED/AMBIGUOUS-mønster som D-57 (D-57/`business-event-sync.ts`), aldri en gjettet kobling.
7. **Open-loop-integrasjon** (§17) GJENBRUKER `OpenLoopService`/`business_open_loops` UENDRET
   mekanisme - additiv `ticket_id`-kolonne + fire nye `loop_type`-verdier, dekket av DEN EKSISTERENDE
   `business-open-loop-sweep`-schedulerjobben - INGEN ny jobb.
8. **Kunde-svar** (`support.reply`) ruter GJENNOM eksisterende `email.send` (klasse D, uendret
   signert godkjenning) - INGEN SMTP bygget, idempotent via `idempotency_key`.
9. **ToolGateway** - nytt `support.*`-namespace, 12 handlinger (A=lesing, B=interne skrivinger,
   C=`reply`) - INGEN support-handling er klasse D.
10. **Q-21/RLS** - `FORCE ROW LEVEL SECURITY` + tenant+memory-space-RESTRICTIVE, samme mønster som
    `business_open_loops` - `jarvis_runtime` uendret NOSUPERUSER/NOBYPASSRLS.
11. **Q-27-gjenbruk** - periodisk innboks-reconciliation bruker DEN SAMME `listBusinessTenantIds()` -
    ingen ny tenant-katalogmekanisme.
12. **Q-20-erasure** - `support_tickets`/`support_ticket_events` registrert i
    `modules/erasure/src/plan.ts`, ny begrunnet `GRANT DELETE` (fant og fikset en reell regresjon:
    uten denne grantet ville hele `erasure-service.test.ts`-suiten feilet).
13. **Host-akseptanseskript** `ua3-native-support-host-run.ts` → `ua3-native-support-live.ts` -
    `FakeTransport` gjennom EKTE ToolGateway/Policy Gateway (ALDRI reell e-postutsendelse).

**Testdekning:** 62 nye tester (1176→1240, full suite grønn), typecheck/lint rene.

**Bygges IKKE i denne sliceen:** Contracts/e-sign (Q-28, uendret); en ekstern support-leverandør-
adapter (Zendesk/Intercom/Freshdesk som valgfri fremtidig kanal, ALDRI domeneeier); AI Mesh-basert
support-vs-ikke-support-klassifisering (routing er BEVISST deterministisk); flerkanal utover e-post
(portal/chat/SMS - domenemodellen støtter det, men ingen ekstra kanal koblet inn nå).

**Akseptansekriterium 1-re-evaluering:** forblir EKSPLISITT PARTIAL - kjernemekanismen (CRM/Sales +
Gmail/Calendar, D-60) er VERIFIED/COMPLETE, Native Support Core er NÅ OGSÅ VERIFIED/COMPLETE
(D-70, host-bevist), MEN Contracts/e-sign FORTSATT ikke bygget - kriterium 1 SOM HELHET derfor
FORTSATT PARTIAL. **HELE UA-3/masterplan v4.0 forblir IKKE komplett.**

#### HOST FIX #1 (2026-08-18, samme branch) → D-67

Tobias sin FØRSTE host-kjøring (`ua3-native-support-host-run.ts`, run_id `60f0d682`/`5457c59a`,
`hard_fail=true`, 18/26 markører PASS) fant to rotårsaker: (1) akseptanse-scriptets egen alltid-null
secret-provider ga en `credential_unavailable`-kaskade (7 avledede FAIL) - fikset ved å gjenbruke
D-57 sitt dummy-credential-mønster (`ua3-business-events-live.ts`); (2) Q-20-erasure av en
support-ticket krasjet mot `business_open_loops_ticket_id_fkey` - fikset via ny migrasjon
`025_business_open_loops_ticket_grant.sql` + en snever, ordnet sletting av support-linkede
open-loops FØR ticketen i `modules/erasure/src/plan.ts`. Under skriving av regresjonstestene for
disse to ble en TREDJE, tidligere maskert rotårsak funnet: `SupportTransport` sin interne
`person_id: "system"`-identitet for det nøstede `email.send`-kallet (klasse D) matchet ALDRI en
konfigurert sovereign eier, saa `support.reply` ville ha FEILET med `class_d_missing_approval`
uansett credential-status - fikset ved å gjenbruke `JARVIS_OWNER_PERSON_ID`-konvensjonen fra
`main.ts`/`worker-main.ts`. 10 nye regresjonstester mot EKTE `ToolGateway`/`PolicyGateway`/
`ErasureService`/embedded Postgres (1240→1250, full suite grønn), typecheck/lint rene. Se D-67.
Fiksen for rotårsak 3 (`JARVIS_OWNER_PERSON_ID`-gjenbruk) viste seg selv å ha et sikkerhetsproblem -
se D-68 under.

#### SECURITY FIX #2 (2026-08-18, samme branch) → D-68

Ekstern sikkerhetsaudit av D-67 sin rotårsak-3-fiks fant en REELL rettighetseskalering:
`ToolTransport.invoke()` fikk aldri den opprinnelige kalleren sin `IdentityContext`, saa ENHVER
kaller autorisert til `support.reply` (eier ELLER en mandat-delegat) fikk sitt nøstede
`email.send` (klasse D) utført med UBETINGET eier-authority. Fikset ved å legge
`ToolInvocationContext` (`{identity, approval}`) til som 4. parameter på `ToolTransport.invoke()` -
`SupportTransport` videreformidler nå den EKTE kallerens identitet/godkjenning UENDRET, ingen
fabrikkert identitet noe sted. Invariant bevist: `effective_authority(nested) <=
effective_authority(caller)`, ALDRI eskalert - 10 nye tester (EKTE `ToolGateway`/`PolicyGateway`/
Ed25519-signerte godkjenninger). 1250→1260 tester. Se D-68.

#### HOST FIX #3 (2026-08-18, samme branch) → D-69 "SYNTHETIC FIXTURE CLEANUP ONLY"

Ekte host-funn, run_id `1e821a86`, `hard_fail=true` - ALLE 25 funksjonelle/sikkerhets-/
Q-20-markører PASSET, KUN `ua3_support_cleanup=FAIL` (to leftover-rader for den syntetiske
akseptanse-tenanten: en bevisst Q-20-fixture i `business_followups`, og den EKTE Q-20-
revisjonsraden i `erasure_requests`). Ingen produksjonsfeil - `cleanupTenant()` utvidet med begge
tabellene via `adminPool` (samme mønster som `q20-erasure-live.ts`), INGEN ny runtime-rettighet,
produksjonens erasure-retensjon UENDRET. 8 nye tester. 1260→1268 tester. Se D-69.

#### ENDELIG LUKKING (2026-08-18, samme branch) → D-70

Fjerde, REN host-kjøring: run_id `da7e0c1b`, `hard_fail=false`, ALLE 26 markører PASS. Repo-sannhet
verifisert FØR lukking (HEAD `2e90d5f`, arbeidstre rent, ingen kjørbar kode endret siden host-
testet SHA). D-66/D-67/D-68/D-69 markeres alle VERIFIED/CLOSED/COMPLETE. Full regresjon: 94
testfiler, 1268/1268 grønne, lint/typecheck rene, GitHub CI grønn. PR #17 klar for review -
**MERGES IKKE uten Tobias sin eksplisitte godkjenning.** Se D-70.

**Kjente åpne gap (ikke skjult - se OPEN_QUESTIONS.md):** Q-25 punkt 8 (oppdatert), Q-28 (Contracts,
uendret).

---

### UA-3 — Native Jarvis Contracts Core (Contracts/e-sign, CONTRACT CORE-halvpart, K1) = VERIFIED/COMPLETE (2026-08-18) → D-71/D-72/D-73

**Status: VERIFIED/COMPLETE (2026-08-18, D-73).** Kode + 104 tester ferdig og lokalt bevist, OG NÅ
ekte host-bevist på Tobias sin Windows/Docker-host: `ua3-native-contracts-host-run.ts`, run_id
`5ca4765b`, `hard_fail=false`, ALLE 26 markører PASS. To tidligere host-runder (D-72, run_id
`1e9ae3a8`/`53d294b8`) fant og fikset en synthetic-cleanup-gap FØR denne rene kjøringen - se
HOST FIX #1-underseksjonen og D-73-avslutningsseksjonen nedenfor for full detalj. Draft-PR #18 er
klar for review - **MERGES IKKE uten Tobias sin eksplisitte godkjenning.**

Implementerer D-64/Q-28 sitt Core-vs-Adapter-vedtak for kontraktdomenet: Contracts skal være
`JARVIS_CANONICAL` (Jarvis eier selv kontrakt-lifecycle/domenemodellen), IKKE en ekstern
e-sign-leverandør. **ZERO DocuSign/PandaDoc/Signicat/Adobe Sign valgt eller integrert** - juridisk
signeringsutførelse forblir en FREMTIDIG, valgfri utførelsesadapter, aldri domeneeier.

**D-64 Core-vs-Adapter-gate kjørt FØR kode (denne gangen PROAKTIVT, ikke reaktivt som for Support):**
CAPABILITY=Contract management; JARVIS_CORE=kontrakt-lifecycle/motparter/versjoner/forpliktelser/
frister/fornyelser/godkjenninger/Business-OS-kobling/open-loops/kanonisk status;
EXTERNAL_ROLE=fremtidig juridisk signeringsutførelse/identitetsverifisering/bevis-levering (KUN
dette); SYSTEM_OF_RECORD=`JARVIS_CANONICAL`; CAN_RUN_WITHOUT_PROVIDER=true (ZERO e-sign-avhengighet,
bevist mekanisk); REPLACEMENT_PATH=signaturleverandøren kan byttes ut uten omskriving av Contracts
Core.

**Bygget:**
1. **Ny pakke `@jarvis/agreements`** (`modules/agreements/`, IKKE `@jarvis/contracts` - det navnet er
   allerede den delte type-kontrakt-pakken `packages/contracts`) + migrasjon `026_contracts.sql` -
   `contracts` (kontraktnummer/tenant/memory-space/motpart-kobling/type/status/effektiv-/start-/
   sluttdato/oppsigelsesfrist/fornyelsesdato/eier/generiske `source_*`/`canonical_uri`-pekere) +
   `contract_versions` (eksplisitt, immutable, append-only) + `contract_obligations`
   (`open/completed/waived`) + `contract_events` (10 hendelsestyper, egen kontrakt-tidslinje,
   EKSPLISITT separat fra `audit_events`).
2. **Deterministisk lifecycle** (`state-machine.ts`) -
   `draft→review→approved→active→expiring→expired→terminated→cancelled`, INGEN LLM avgjør gyldighet;
   `terminated`/`cancelled` praktisk talt terminale (ENESTE vei videre: eksplisitt administrativ
   korreksjon tilbake til `draft`, ALDRI direkte til `active`).
3. **Eksplisitte, immutable versjoner** - kun nye append-only rader (ingen `updated_at`), atomisk
   `version_number`-beregning under radlås - pointer-not-payload (`canonical_uri` peker til det
   faktiske dokumentet, kopierer ALDRI innhold; strukturelt bevist: ingen `body`/`content`/
   `document_text`-kolonne finnes).
4. **Motparter gjenbruker EKSISTERENDE `business_companies`/`business_contacts`** - INGEN ny
   motpart-tabell (byggeordrens eksplisitte krav).
5. **Forpliktelser** (`contract_obligations`) besvarer "hva må vi gjøre"/"hva forfaller
   neste"/overdue-spørsmål deterministisk - eier/frist/status, komplett/frafalt/gjenåpnet-overganger.
6. **Open-loop-integrasjon** GJENBRUKER `OpenLoopService`/`business_open_loops` UENDRET mekanisme -
   additiv `contract_id`-kolonne + fire nye `loop_type`-verdier (`contract_renewal_due`/
   `contract_termination_deadline`/`contract_obligation_due`/`contract_review_required`), dekket av
   DEN EKSISTERENDE `runOpenLoopSweepForAllTenants`-schedulerjobben - INGEN ny jobb/motor.
7. **ToolGateway** - nytt `contract.*`-namespace, 24 handlinger (A=lesing, B=interne skrivinger,
   C=`set_status` - lifecycle-overgang har reelt effektnivå utover en vanlig feltoppdatering) - INGEN
   klasse D i denne sliceen (ingen nøstet ekstern/uigjenkallelig handling finnes ennå).
8. **Q-21/RLS** - `FORCE ROW LEVEL SECURITY` + tenant+memory-space-RESTRICTIVE på alle fire tabeller,
   samme mønster som `support_tickets` - `jarvis_runtime` uendret NOSUPERUSER/NOBYPASSRLS.
9. **Q-27-gjenbruk** - ingen ny tenant-katalogmekanisme, sveipen kjører som del av EKSISTERENDE
   `runOpenLoopSweepForAllTenants()`.
10. **Q-20-erasure** - alle fire tabeller + kontrakt-tilknyttede `business_open_loops`-rader
    registrert i `modules/erasure/src/plan.ts` FØR noen host-runde (samme FK-lærdom som HOST FIX
    #1/D-67 for Support, anvendt forebyggende denne gangen - ingen host-runde skulle trenges for å
    finne dette).
11. **Q-26-grense uendret** - kontraktdokumenter er KILDEDATA, blir IKKE automatisk "verifisert
    kunnskap" av denne sliceen.
12. **Host-akseptanseskript** `ua3-native-contracts-host-run.ts` → `ua3-native-contracts-live.ts` -
    INGEN e-sign-leverandør-oppsett, INGEN signaturleverandør-credential, INGEN manuell SQL kreves.

**Testdekning:** 96 nye tester (typecheck 16/16 rent, lint rent, full lokal suite 1347/1347 grønn
utenom én kjent, urelatert ressurs-flaky embedded-postgres-`afterAll`-timeout i
`modules/knowledge/test/registry.test.ts`, PASS 11/11 i isolasjon).

**Bygges IKKE i denne sliceen:** juridisk signeringsutførelse/e-sign-leverandør av noe slag (Q-28
SIGNATURE EXECUTION PROVIDER-halvparten, krever en eksplisitt Tobias-leverandørbeslutning FØRST);
UA-4; AI Mesh-basert kontraktstolkning (INGEN inferert kontraktsmening utover eksplisitt lagrede/
utpekte data, ingen juridisk rådgivning).

#### HOST FIX #1 (2026-08-18, samme branch) → D-72 "SYNTHETIC CLEANUP ONLY"

To ekte Windows/Docker-host-kjøringer (run_id `1e9ae3a8`/`53d294b8`) ga BEGGE `hard_fail=true`, men
ALLE 25 funksjonelle/sikkerhets-/Q-20-markører PASSET - KUN `ua3_contracts_cleanup=FAIL`
(`business_followups_tenant_id_fkey`, 1 rad). Rotårsak: Q-20-seksjonen i
`ua3-native-contracts-live.ts` oppretter bevisst en `business_followups`-akseptansefixture (for å
bevise erasure-scope-presisjon) som `cleanupTenant()` aldri ryddet - EKSAKT samme feilklasse som
Native Support Core sin HOST FIX #3 (D-69), IKKE en Contracts-domenebug. Skjema-/FK-audit bekreftet
INGEN andre skjulte tilleggsfunn. Fikset: `cleanupTenant()` utvidet med
`DELETE FROM business_followups`, `selfHeal()` bruker samme funksjon uendret. 8 nye
regresjonstester (`ua3-native-contracts-cleanup.test.ts`). Produksjonens
`business_followups`-retensjon uendret. **Status forblir FUNKSJONELT HOST-BEVIST, IKKE
VERIFIED/CLOSED** til én ren host-kjøring ender `hard_fail=false`.

**Kjente åpne gap (ikke skjult - se OPEN_QUESTIONS.md):** Q-28 (SIGNATURE EXECUTION PROVIDER-halvpart,
fortsatt ikke besluttet - denne raden lukkes IKKE av dette bygget alene); ekte host-verifisering
(Tobias må kjøre `ua3-native-contracts-host-run.ts` før VERIFIED/COMPLETE kan hevdes).

#### ENDELIG LUKKING (2026-08-18, samme branch) → D-73 "REN HOST-KJØRING"

Tobias sin TREDJE host-kjøring (`ua3-native-contracts-host-run.ts`, run_id `5ca4765b`) ga
`hard_fail=false`, ALLE 26 markører PASS, inkludert `ua3_contracts_cleanup` (FAIL i D-72 sine to
runder). Repo-sannhet bekreftet FØR lukking: lokal og `origin/claude/ua3-native-contracts-core`
HEAD identisk (`8d530e6`), arbeidstreet rent, INGEN kjørbar kode endret etter den host-testede
SHA-en - D-72 sin `cleanupTenant()`-fiks er den eksakte koden som ble host-testet. **D-71/D-72
markeres begge VERIFIED/COMPLETE.** Runtime bekreftet `jarvis_runtime`/`superuser=false`/
`bypassrls=false` - Q-21 uendret. Q-27 gjenbruker `listBusinessTenantIds()` uendret. Q-20:
`ErasureService` host-bevist reelt (kontrakt/versjoner/forpliktelser/events/kontrakt-linket
open-loop fjernet, urelatert open-loop upåvirket, ingen resurrection). Q-26 uendret (kontrakter
forblir kildedata). **Q-28 splittes formelt i to halvdeler:** CONTRACT CORE = VERIFIED/COMPLETE
(denne raden, FERDIG); SIGNATURE EXECUTION ADAPTER = fortsatt ÅPEN/DECISION REQUIRED (ingen
leverandør valgt, krever egen fremtidig D-64-port + eksplisitt Tobias-beslutning). **K1 ("Hva
skjer med kunde X?") re-evaluert mot det ordrette masterplan-kriteriet** (kun "complete
source-backed timeline", ingen nevning av juridisk e-signatur) - CRM/Sales, Support/tickets (D-70)
og Contracts Core (D-73) er ALLE nå host-verifisert og bidrar til Business OS-tidslinjen. **K1
markeres derfor NÅ VERIFIED/COMPLETE** (se D-73 i DECISIONS_AND_ASSUMPTIONS.md for full
begrunnelse). **HELE UA-3 forblir IKKE komplett** (akseptansekriterium 2, tverr-domene
sales/product/finance/marketing/operations, avhenger av UA-4/UA-5/UA-6 - ingen startet). **HELE
Sovereign Autonomy-masterplanen forblir IKKE komplett.** Full lokal suite grønn, typecheck/lint
rene, GitHub CI (`gitleaks`+`build-test`) grønn på `8d530e6`. PR #18 klar for review -
**MERGES IKKE uten Tobias sin eksplisitte godkjenning. STOP etter denne lukkingen. Ingen
signaturleverandør. Ingen UA-4.**

---

### UA-4 — Native Jarvis Growth Core (Growth & Marketing Control Plane, UA4_SLICE_1) = FIXED_SUITE / IKKE HOST VERIFIED (2026-08-19) → D-74

**Status: FIXED_SUITE / IKKE HOST VERIFIED.** Kode + 66 nye tester ferdig og lokalt bevist (embedded
Postgres, IKKE en ekte host-kjøring - dette miljøet har ikke Docker/Tobias sin Windows-host
tilgjengelig). `ua4-growth-core-host-run.ts` er skrevet og klar til å kjøres av Tobias, men status
forblir ærlig FIXED_SUITE til den faktisk er kjørt - **ALDRI hevdet VERIFIED/COMPLETE uten det
beviset** (samme disiplin som D-66/D-71 krevde før sine host-fix-runder). Draft-PR opprettes -
**MERGES IKKE uten Tobias sin eksplisitte godkjenning.**

**UA-4 canonical scope (fra `docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md` - INGEN
UA-4-detalj fantes fra før i CANONICAL_SPEC/ARCHITECTURE/IMPLEMENTATION_PLAN, masterplanen er derfor
eneste kanoniske kilde, ingen motstrid å rapportere):** Google Ads/Meta Ads/GA4/Search Console/GBP/
LinkedIn/YouTube/TikTok, attribusjon spend→click→lead→meeting→customer→revenue, eksperimentregister,
avviksdeteksjon, kreativ intelligens, markedsføringsminne, autonome budsjett-/bud-/kampanje-/
nøkkelord-/kreativ-endringer når plattformtillatelse finnes, Finance Integrity Gateway for audit/
reconciliation (IKKE spend-cap). **Literale akseptansekriterier:** CAC/ROAS knyttet til ekte
CRM/revenue; tracking-/kampanje-avvik detektert og handlingsbart; skrivehandlinger idempotente/
auditerbare/med before-after-state; samtykke/cookie/databehandlingskrav dokumentert for produksjons-
sporing.

**D-64 Core-vs-Adapter-porten kjørt FØRST:** `CAPABILITY=`vekst-/markedsføringsattribusjon og
kampanjesporing; `JARVIS_CORE=`kampanjeregister/utgiftsledger/attribusjonsgraf/CAC-ROAS/
eksperimentregister/avviksdeteksjon/Business OS-kobling; `GENUINE_EXTERNAL_NEED=`RÅ utgifts-/klikk-/
visningstall og faktisk annonseplattform-utførelse; `SYSTEM_OF_RECORD=HYBRID_WITH_CLEAR_AUTHORITY`
(attribusjon/kampanjesporing/eksperimentregister/avviksdeteksjon = `JARVIS_CANONICAL`; RÅ spend-/
klikk-/visningsfakta fra en fremtidig plattform = `EXTERNAL_CANONICAL`, samme pointer-not-payload-
prinsipp som kontraktdokumenter); `CAN_RUN_WITHOUT_PROVIDER=true`; `REPLACEMENT_PATH=`enhver
annonseplattform utskiftbar uten omskriving av kjernemodellen. INGEN `CORE_DEPENDENCY_DECISION_
REQUIRED` - full begrunnelse i DECISIONS_AND_ASSUMPTIONS.md D-74.

**UA4_SLICE_1 valgt: Native Jarvis Growth Core** (kanonisk kampanje-/utgifts-/attribusjon-/
eksperimentmodell, ZERO annonseplattform-connector) - obligatorisk fundament for alt annet
UA-4-arbeid, fremmer literale akseptansekriterier direkte, fremmer UA-3 kriterium 2 sitt
"marketing"-domene, uavhengig nyttig alene, fullt host-verifiserbart uten noen live-credential,
unngår unødvendig leverandørbinding - EKSAKT samme "Core FØR Adapter"-mønster som D-71.

**Ny pakke `@jarvis/growth`** (`modules/growth/`) + migrasjon `027_growth.sql`:
`marketing_campaigns`/`marketing_spend_events`/`marketing_attributions`/`marketing_experiments`/
`marketing_campaign_events`, FORCE RLS (samme tenant+space RESTRICTIVE-mønster som
`026_contracts.sql`). **Kampanjer er BEVISST IKKE knyttet til ett selskap** - en kampanje sikter mot
fremtidige/ukjente leads, i motsetning til Support/Contracts (alltid én kunde); "Hva skjer med kunde
X?" dekkes via `growth.list_by_company()` GJENNOM en attribuert lead/opportunity. **Deterministisk
lifecycle**: kampanje `draft→active→paused→ended` (korreksjon kun `ended→draft`), eksperiment
`draft→running→concluded/abandoned` (korreksjon kun tilbake til `draft`) - INGEN LLM avgjør
gyldighet. **Idempotent utgifts-ingestion**: `UNIQUE(tenant_id, campaign_id, event_date, source_type)`,
`ON CONFLICT DO UPDATE`, before/after eksplisitt logget på `spend_recorded`-eventet. **Attribusjon**
EKSPLISITT/deterministisk (polymorft `entity_type`/`entity_id` mot EKSISTERENDE `business_leads`/
`business_opportunities`, samme mønster som `business_scores`/D-62) - ALDRI AI-gjettet. **CAC/ROAS**
(`campaignPerformance()`) ren deterministisk SQL-aggregering mot ekte `business_opportunities.
value_ore`/`stage='won'` - `cac_ore`/`roas` er `null` (ALDRI `0`/fabrikkert) når nevneren er `0`.
**Eksperimentregister** - `result_summary` strukturert/menneske-registrert, ALDRI en AI-generert
kausal påstand (Q-26-grensen). **OpenLoopService** (IKKE en ny motor) utvidet med
`marketing_spend_anomaly` (siste utgiftsdag vs. glidende 7-dagers-snitt, terskel ×1.5/÷1.5,
beløps-gulv 100 øre mot støy) + `business_open_loops.campaign_id`-pekerkolonne. **`growth.*`-
ToolGateway-namespace** (16 handlinger): klasse A lesing, klasse B interne skrivinger, klasse C for
`set_campaign_status`/`set_experiment_status` (ingen klasse D i denne sliceen - ingen nøstet ekstern
annonseplattform-handling finnes ennå). **Q-20**: alle fem tabeller + kampanje-tilknyttede
`business_open_loops`-rader registrert i `modules/erasure/src/plan.ts` FØR noen host-runde (samme
FK-lærdom som HOST FIX #1/D-67, anvendt proaktivt). **Q-27**: gjenbruker `listBusinessTenantIds()`
uendret. **Q-26**: uendret - attribusjon/eksperimentresultater er deterministisk beregnet/
menneske-registrert, ALDRI automatisk "verifisert kunnskap".

**Samtykke/cookie/databehandling for produksjonssporing** (akseptansekriterium 4): IKKE dokumentert
i denne sliceen - blir relevant FØRST når en faktisk sporings-/annonsekonto-connector kobles inn,
eksplisitt notert som gjenstående i Q-29 (IKKE stille utelatt).

66 nye tester (`modules/growth/test/`: state-machine 13, service-rls 28, transport-wiring 10;
`modules/business/test/open-loop-growth.test.ts`: 9; `modules/erasure/test/growth-erasure.test.ts`: 6).
`pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent, full lokal suite 1412/1412 grønn.

**Bygges IKKE i denne sliceen:** noen live annonseplattform-connector (Google Ads/Meta Ads/GA4/
Search Console/GBP/LinkedIn/YouTube/TikTok - krever egen D-41/D-64-vurdering PER plattform, se
Q-29); autonome budsjett-/bud-/kampanje-endringer; kreativ intelligens/markedsføringsminne; Finance
Integrity Gateway-integrasjon (UA-6, ikke startet); UA-5.

**Kjente åpne gap (ikke skjult - se OPEN_QUESTIONS.md Q-29):** live annonseplattform-connectorer,
autonome spend-endringer, kreativ intelligens, samtykke-/cookie-dokumentasjon, deterministisk
UTM-auto-attribusjon, `BUSINESS_DOMAIN_COVERAGE`-kabling for `marketing` i daglig/ukentlig brief;
ekte host-verifisering (Tobias må kjøre `ua4-growth-core-host-run.ts` før VERIFIED/COMPLETE kan
hevdes).

#### ENDELIG LUKKING (2026-08-19, samme branch) → D-74 "REN HOST-KJØRING"

Tobias sin FJERDE host-kjøring (`ua4-growth-core-host-run.ts`, run_id `8f2b89e1`) ga `hard_fail=
false`, ALLE 23 markører PASS (19 opprinnelige + 4 spend-delmarkører introdusert i D-76), inkludert
`ua4_growth_spend_idempotent`/`ua4_growth_cac_roas`/`ua4_growth_open_loop_resolved` (FAIL i de tre
foregående rundene, D-75/D-76). Repo-sannhet bekreftet FØR lukking: lokal og
`origin/claude/ua4-growth-core` HEAD identisk (`598f454`), arbeidstreet rent, INGEN kjørbar kode
endret etter den host-testede SHA-en - D-76 sin `pgDateToIsoDate()`-fiks er den eksakte koden som
ble host-testet, ingen re-kjøring nødvendig. **D-74/D-75/D-76 markeres alle VERIFIED/COMPLETE.**
Runtime bekreftet `jarvis_runtime`/`superuser=false`/`bypassrls=false` - Q-21 uendret gjennom alle
fire runder. Q-27 gjenbruker `listBusinessTenantIds()` uendret. Q-20: `ErasureService` host-bevist
reelt (kampanje/utgiftshendelser/attribusjoner/eksperimenter/kampanje-events/kampanje-linket
open-loop fjernet, urelatert open-loop upåvirket, ingen resurrection). Q-26 uendret (attribusjon/
eksperimentresultater forblir deterministisk beregnet/menneske-registrert). **UA-3 akseptanse-
kriterium 2 re-evaluert mot det ordrette masterplan-kriteriet** (`docs/input/02_..._v4.0.md` linje
470: *"'Hvordan går bedriften?' kombinerer sales, product, finance, marketing, operations"*) - i
motsetning til K1 (D-73), som er et RESULTAT-kriterium ("gir en komplett tidslinje"), er dette et
eksplisitt INTEGRASJONS-kriterium ("kombinerer") - Growth Core gir NÅ en ekte, kanonisk,
host-verifisert markedsførings-datakilde i Business OS, MEN `BUSINESS_DOMAIN_COVERAGE`
(`modules/business/src/business-brief.ts`) er BEVISST IKKE endret i denne sliceen -
`marketing: "not_integrated"` er FORTSATT en hardkodet literal i den faktiske kjørende koden, ingen
spørring mot `growth.*` finnes der. **Kriterium 2 er derfor FORTSATT IKKE oppfylt** - en ekte
datakilde å kombinere finnes nå, men selve kombineringen (kablingen inn i brief-aggregeringen) er
ugjort arbeid, eksplisitt registrert i Q-29 punkt 7, IKKE stille utelatt. `sales="available"`
(uendret), `marketing`="not_integrated" i kode (men datakilde nå EKSISTERER, klar for fremtidig
kabling), `product`/`finance`/`operations`="not_integrated" (helt ubygget, uendret). **HELE UA-3
forblir IKKE komplett.** **HELE Sovereign Autonomy-masterplanen forblir IKKE komplett.** Full lokal
suite grønn (106/106 filer, 1422/1422 tester), typecheck/lint rene, GitHub CI
(`gitleaks`+`build-test`) grønn på `598f454`. PR #19 klar for review - **MERGES IKKE uten Tobias sin
eksplisitte godkjenning. STOP etter denne lukkingen. Ingen annonseplattform-connector. Ingen ny
UA-4-slice startet i denne lukkingen.**

#### UA4_SLICE_2: GROWTH → BUSINESS DOMAIN COVERAGE-INTEGRASJON (2026-08-19) → D-78

Lukker det ovenstående, eksplisitt registrerte Q-29 punkt 7-gapet: `BUSINESS_DOMAIN_COVERAGE`
hardkodet FORTSATT `marketing: "not_integrated"` etter at Native Growth Core allerede var
VERIFIED/COMPLETE (D-77) - datakilden fantes, men var ikke koblet inn i selve rapporteringen.
**D-64-gate kjørt FØRST:** `CAPABILITY=`domenedekning-rapportering for marketing;
`SYSTEM_OF_RECORD=JARVIS_CANONICAL`; `CAN_RUN_WITHOUT_PROVIDER=true` - ingen leverandør
introdusert. **Design (bevisst IKKE en blind streng-flipp):** `BUSINESS_DOMAIN_COVERAGE`-verdien
utvidet fra en bar `"available"|"not_integrated"`-streng til `{status, source,
live_provider_connected}` - domenekapabilitet (`status`) og ekstern leverandør-tilkobling
(`live_provider_connected`) er BEVISST separate felt, forveksles ALDRI. `marketing.status =
"available"` (source: Native Jarvis Growth Core), `marketing.live_provider_connected = false`.
`sales`/`product`/`finance`/`operations` uendret i sak. `renderDomainCoverage()` viser nå
eksplisitt leverandør-uavhengighet for tilgjengelige domener og en presis N/5-telling.
**24 nye/oppdaterte tester** (marketing tilgjengelig+kilde+leverandør-uavhengighet,
sales/product/finance/operations uendret, render-tekst, determinisme, strukturell
leverandør-uavhengighet, ukentlig brief sitt `data_coverage`-felt identisk på tvers av tenants,
host-run-wiring). **Ny host-akseptanse** (`ua4-growth-domain-coverage-host-run.ts`/`-live.ts`,
samme etablerte mønster) - kjørt lokalt mot ekte embedded Postgres FØR commit (Docker ikke
tilgjengelig i denne økten), fanget OG fikset en ekte FK-rekkefølge-bug i cleanup
(`marketing_campaign_events` FØR `marketing_campaigns` - `growth.createCampaign()` logger
automatisk et event, samme feilklasse som D-67/D-69/D-72). To rene smoke-kjøringer etter fiksen:
`hard_fail=false`, alle 10 markører PASS (smoke-test, denne økten). Q-20 N/A (ingen ny
tabell/persistert data). Q-21/Q-27/Q-26 uendret. INGEN ny ToolGateway-handling.

**D-79 (2026-08-19): CI-akseptanse erstatter manuell host-kjøring (slice-spesifikt unntak).**
Tobias ønsket ingen manuell Windows/Docker-host-kjøring for DENNE sliceen. Kvalifiseringssjekk mot
faktisk diff bekreftet: ingen DB-migrasjon, ingen ny persistert domenetilstand, ingen credential,
ingen ekstern leverandør, ingen ny ToolGateway-handling, ingen OS-/Docker-spesifikk atferd, ren
rapporteringsendring, allerede ekte-Postgres-testdekning. Ny verifiseringsklasse innført:
`HOST_VERIFIED` (ekte host-kjøring, fortsatt krevd for leverandør-/Docker-/credential-/nettverks-/
Home Assistant-/tale-/maskinvare-/Windows-spesifikke slices) vs. `CI_VERIFIED` (automatisert,
CI-eksekvert, ekte Postgres, ingen mocking av komponenten under test - en ANNEN, ikke svakere,
bevis-kilde). Ny test `business-brief.test.ts` describe "E" beviser Business OS-tidslinjen
(`companyTimeline()`) upåvirket av en sameksisterende ekte `marketing_campaigns`-rad - kjører mot
ekte embedded Postgres som del av `pnpm test` i CI (`build-test`-jobben). Alle 10 host-script-
markører kartlagt til automatisert CI-dekning (ingen fabrikkert PASS der en markør ikke er
anvendbar). `Q21_REGRESSION=UNCHANGED` - kanonisk `runtime-role.test.ts` uendret, 6/6 grønn.
Host-scriptet (`ua4-growth-domain-coverage-host-run.ts`/`-live.ts`) beholdt KUN som
referanse/feilsøking - IKKE lenger release-gate, `TOBIAS_HOST_ACTION_REQUIRED=false`.
`pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent, full lokal suite 107/107 filer, 1439/1439
tester grønn (+1 §E-test), lokal `gitleaks` "no leaks found". **D-78 status: `CI_VERIFIED /
COMPLETE`** (aldri `HOST_VERIFIED`). **UA4_SLICE_2 = VERIFIED/COMPLETE.** **UA-3 kriterium 2
UENDRET:** `sales=AVAILABLE marketing=AVAILABLE product/finance/operations=NOT_INTEGRATED` -
**fortsatt IKKE komplett** (2/5 domener, krever alle fem). **UA-4 SOM HELHET forblir IKKE
komplett.** Dette er en SLICE-SPESIFIKK beslutning, IKKE en generell fjerning av host-verifisering
for fremtidig UA-4-arbeid. Draft-PR #20 oppdatert, IKKE merget. Full detalj: D-78/D-79 i
DECISIONS_AND_ASSUMPTIONS.md. **PR #20 senere MERGET 2026-08-19 etter Tobias sin eksplisitte
godkjenning** (merge-SHA `f602040`).

#### JARVIS AI MESH — GEMMA-FIRST KOST-/PERSONVERNARKITEKTUR (2026-08-19) → D-80

Claude er IKKE lenger standardmodell for ordinær 24/7-drift. Jarvis er nå Gemma-først for egnede
oppgaver, lokal-først for sensitive oppgaver når lokal inferens finnes, og Claude er et EKSPLISITT
eskaleringsmål - IKKE fjernet, IKKE svekket som premium-provider. **D-64-gate:** `JARVIS_CORE=`
rutingpolicy/kapabilitetsregister/kost-/helse-/budsjett-sporing (allerede eksplisitt utpekt som
referanse-eksempelet på korrekt adapter-grense i `ARCHITECTURE.md` §11.1 FØR denne sliceen);
`EXTERNAL_ROLE=`selve modell-inferensen; `SYSTEM_OF_RECORD=JARVIS_CANONICAL`;
`CAN_RUN_WITHOUT_PROVIDER=true`. **D-41-gate for hostet Gemma:** full støttet kapabilitetsflate
wiret (tekst, ekte tool/function calling via Gemini API, strukturert output, usage/helse/retry/
timeout/kansellering), streaming BEVISST utelatt (samme grense som eksisterende `GeminiAdapter`) -
ingen oppdiktet API-kapabilitet, modell-ID-ene (`gemma-4-26b-a4b-it` default, `gemma-4-31b-it`
alternativ) er oppgitt av Tobias.

**To nye providere** (`packages/provider-adapters`): `gemma.ts` (`GemmaHostedAdapter`,
`name="gemma_hosted"`, samme `generateContent`-REST-mønster/nøkkel-i-header-sikkerhet som
`gemini.ts`, `GEMMA_API_KEY` faller tilbake til `GEMINI_API_KEY`) og `local-llm.ts`
(`LocalOpenAiCompatibleAdapter`, `name="local_llm"`, provider-nøytralt OpenAI-kompatibelt lokalt
endepunkt, `LOCAL_LLM_BASE_URL`/`LOCAL_LLM_MODEL`, INGEN default-URL/IP, INGEN antakelse om samme
maskin som Jarvis). Begge går gjennom SAMME `ModelGateway.executeToolCall()` → `ToolGateway` →
`PolicyGateway`-kjede som alle andre providere - INGEN ny sikkerhetsvei, A-D-risikoklassene uendret.

**Personvern-klassifisering** (oppfyller D-23 sitt aldri-implementerte "Model Gateway-ruting per
space fra fase 3"-mandat): ny `DataSensitivity`-type i `@jarvis/contracts`
(`PUBLIC_OR_LOW_SENSITIVITY`/`PRIVATE`/`BUSINESS_CONFIDENTIAL`/`SECRET_RESTRICTED`), VALGFRITT
`sensitivity`-felt på `RouteInput`/`CompleteInput` (udefinert = eksakt samme ruting som før,
migrasjonssikkert). Ny `hosted_free_tier`-markør på `ModelProfile` (KUN `gemma_hosted=true`, alle
eksisterende providere uendret `false`). Router (`isSensitivityEligible()`):
`PRIVATE`/`BUSINESS_CONFIDENTIAL` ekskluderer `hosted_free_tier`-providere helt, foretrekker lokal
(myk scoring-bonus, IKKE et hardt krav); `SECRET_RESTRICTED` = KUN lokale providere kvalifisert,
fail-closed (`NoEligibleProviderError`) uten lokal tilgjengelig - gjelder OGSÅ eksplisitt
eier-override. To nye `RoutingReason`-verdier (`PRIVACY_RESTRICTED`/`PRIVACY_PREFERS_LOCAL`).

**Standard-ruting** (bevist matematisk via eksisterende, uendret scoring-formel + nye registry-tall,
INGEN spesialtilfelle-kode): `gemma_hosted` (cost_class=1, quality_class=4, latency_class=fast)
vinner AUTO/BACKGROUND/QUICK_CLASSIFICATION-ruting når ingen sensitivitet blokkerer det. Claude/
OpenAI eskaleres til via EKSISTERENDE mekanismer: `mode="QUALITY"`/`"CRITIC"` (kvalitet slår kost),
`purpose="VISION"` (kun `anthropic` har ekte bilde-wiring), eksplisitt `provider`-override.

**Bugfiks fanget under gjennomgangen:** `gemini`-profilen hevdet feilaktig `streaming: true` selv
om `GeminiAdapter` aldri har hatt en `.stream()`-metode - fjernet (aldri en krasj-bug, kun en
unøyaktig capability-påstand som brøt filens egen dokumenterte regel).

**Bakgrunnsjobb-audit** (uttømmende): ALLE `DailyScheduler`-jobber (daglig brief, open-loop-sveip,
business-event-sync, scoring-sveip, support-inbox-sync) er 100% deterministiske - INGEN kaller
`ModelGateway`. To faktiske modell-berørende stier: `apps/api/src/executive.ts` sin generiske
executive-worker (arver Gemma-standarden automatisk, men sender IKKE ennå `sensitivity` - Q-30) og
`modules/knowledge/src/ocr-provider.ts` sin vision-extractor (forblir 100% Anthropic, ingen
Gemma-vision-wiring i denne sliceen).

**44 nye tester (22 + 22 = 44, korrigert - se D-81 §10):** `modules/model-gateway/test/gemma-first-routing.test.ts` (22, full
routing-matrise) + `packages/provider-adapters/test/conformance.test.ts` utvidet (22 nye saker for
`gemma_hosted`/`local_llm`). Full monorepo-regresjon: `pnpm -w typecheck` 17/17 rent, `pnpm -w lint`
rent, full lokal suite 108/108 filer, 1483/1483 tester grønn (var 1439 - ren addisjon, INGEN
eksisterende test endret). **Migrasjonssikkert** (§23): `sensitivity` er et nytt valgfritt felt,
INGEN eksisterende kalleside endret faktisk ruting; trygg rollback = fjerne de to nye adapterne fra
`providers`-listen i `main.ts`/`worker-main.ts` (samme mekanisme som enhver annen adapter).

**Gjenstående, eksplisitt IKKE bygget** (registrert som Q-30): bakgrunnsjobb-avsender-
sensitivitetsklassifisering, Gemma vision-wiring, hostet Gemma streaming, dedikert
eskaleringsorkestrator (eksisterende mode-basert eskalering brukt i stedet), lokal
Gemma-maskinvare (ikke konfigurert i denne økten), kostmetrikk-dashbord (beregnbart fra eksisterende
`cost_events`-data, ikke bygget). **INGEN ekte live-provider-kjøring i denne økten** (ingen
API-nøkkel konfigurert) - arkitektur-/enhets-/integrasjonsverifisering IKKE blokkert av dette, alt
bevist mot mocket `fetch`. Draft-PR opprettes, IKKE merget. Claude/OpenAI/Anthropic/Gemini/Kimi
IKKE fjernet - alle forblir registrert og tilgjengelig via samme ruting. Full detalj: D-80 i
DECISIONS_AND_ASSUMPTIONS.md.

#### PR #21 — PRE-MERGE SECURITY + D-41 HARDENING (2026-08-19) → D-81

Pre-merge sikkerhetsherding av D-80 FØR review. **P0-funn:**
`UNCLASSIFIED_CAN_ROUTE_TO_HOSTED_FREE_TIER=true` FØR fiksen - `isSensitivityEligible()` tolket
udefinert `sensitivity` som "ingen filtrering" for ALLE providerkategorier, inkl.
`hosted_free_tier`. `apps/api/src/executive.ts` OG `apps/api/src/conversation.ts` (hoved-
samtalemotoren - IKKE tidligere revidert i D-80, funnet i denne runden) sender begge INGEN
`sensitivity`. **Fikset:** `hosted_free_tier`-providere krever nå eksplisitt
`sensitivity === "PUBLIC_OR_LOW_SENSITIVITY"` (fail-safe) - gjelder også eier-override. Alle andre
providere beholder uendret ruting for udefinert sensitivitet. Konsekvens: `gemma_hosted` vinner ikke
lenger AUTO/BACKGROUND for udefinert sensitivitet (faller tilbake til openai/gemini, som FØR D-80).

**D-41 korrigert** (WebSearch mot offisiell Gemini API-/Gemma-dokumentasjon - WebFetch blokkert av
egress-proxy): Gemma 4 støtter ekte bildeforståelse - **vision nå implementert**
(`gemma.ts` sin `toGemmaParts()`, `inlineData`-mapping, samme mønster som `anthropic.ts`),
personvern-gaten forblir autoritativ (e-post-OCR forblir 100% Anthropic). Streaming:
`PROVIDER_SUPPORT=true`/`ADAPTER_SUPPORT=false` (bevisst utsatt, ikke-trivielt, Q-30) - IKKE lenger
feilaktig fremstilt som en Gemma-leverandørbegrensning.

**Pris-sannhet:** `pricing.ts` sin `TokenRate` fikk `pricing_mode`/`pricing_verified_at`
(`gemma_hosted=FREE_TIER/2026-08-19`, `local_llm`/`ollama`=LOCAL) - arkitekturen støttet allerede
dynamisk prisoppdatering via `GatewayOptions.pricing`. Rate-limit/router-økonomi verifisert korrekt
matematisk, ingen kodeendring nødvendig.

**Testregnskap korrigert:** D-80 sin opprinnelige rapport sa feilaktig "26 nye tester" - faktisk
tall var 44 (22+22). D-81 la til 14 flere (11 routing + 3 vision). Nytt totalregnskap: `main` FØR
D-80=1439 → ETTER D-80=1483 (+44) → ETTER D-81=1497 (+14), 108/108 filer grønn alle ganger.
`pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent, lokal `gitleaks` "no leaks found".

**D-80 = CI_VERIFIED/COMPLETE ETTER denne fiksen.** PR #21 forblir draft, IKKE merget. Ingen AI
Market/Cost Optimizer bygget, ingen nye providere utover D-80 sine to, ingen Tobias-secret-oppsett.
Full detalj: D-81 i DECISIONS_AND_ASSUMPTIONS.md.

---

#### UA-4 SLICE 3 — DETERMINISTISK UTM-/KLIKK-ID-BASERT AUTO-ATTRIBUSJON (2026-08-19) → D-82

Neste UA-4-slice etter PR #21 (D-80/D-81, MERGET, merge-SHA `7b9789d`) - valgt via repo-sannhet-audit
(`origin/main` verifisert eksakt `7b9789d`), IKKE Google Ads-default. Lukker Q-29 punkt 6.

**Slice-valg:** 8 kandidater sammenlignet eksplisitt (gjenstående domenedekning-integrasjon - allerede
lukket av D-78; attribusjon-ingestion-fundament - **VALGT**; analytics-/sporings-kildefundament;
første live markedsføringsprovider; kreativ intelligens; autonom markedsføringshandling;
samtykke-/personvern-styring; Finance Integrity Gateway-avhengighet). `027_growth.sql` sin EGEN
kildekommentar sa ordrett "se OPEN_QUESTIONS.md for fremtidig deterministisk UTM-basert
auto-matching" - dette ER den forhåndsplanlagte, leverandør-uavhengige neste utvidelsen
(platform-agnostisk, ZERO ekstern leverandørvalg kreves). De øvrige kandidatene krever enten en
Tobias-leverandørbeslutning (D-64/D-41-port PER plattform) eller reelle kampanjedata fra en
live-connector som ikke finnes ennå.

**D-64-gate:** `CAPABILITY=`deterministisk kobling av lead/opportunity til kampanje via
sporingsparametre; `SYSTEM_OF_RECORD=JARVIS_CANONICAL`; `EXTERNAL_PROVIDER_GENUINELY_REQUIRED=false`
(ren applikasjonslag-oppslagslogikk mot Jarvis sine EGNE registrerte tagger, ZERO Google Ads/Meta
Ads/GA4-credential/tabell/endepunkt); `CORE_DEPENDENCY_DECISION_REQUIRED=false`. D-41 IKKE
anvendelig (ingen provider introdusert).

**Implementasjon ("smallest complete"):** migrasjon `028_growth_attribution_tracking.sql` - ny
`marketing_campaign_tracking_tags`-tabell, to gjensidig utelukkende taggtyper (`click_id`:
gclid/fbclid/msclkid + verdi; `utm`: full `(utm_source, utm_medium, utm_campaign)`-triplett sammen,
ALDRI et delvis felt alene), håndhevet BÅDE av en DB-CHECK-constraint OG TypeScript-unionstyper. To
partial UNIQUE-indekser sikrer BÅDE idempotent registrering (ON CONFLICT DO UPDATE) OG at ambiguity
er STRUKTURELT umulig (databasen selv garanterer at én tagg-verdi ALDRI kan peke til to kampanjer
samtidig). Ny `CampaignEventType`-verdi `tracking_tag_registered`.

**`GrowthService`-utvidelse (4 nye metoder):** `registerCampaignTrackingTag()` (idempotent),
`listCampaignTrackingTags()`, `resolveCampaignFromTracking()` (rent deterministisk oppslag -
returnerer `null`, ALDRI en gjettet kampanje, ved ingen EKSAKT match - Q-26-grensen),
`attributeFromTracking()` (løser kampanje FØRST, kaller SÅ den EKSISTERENDE `attributeToCampaign()`
UENDRET - ingen ny attribusjonsmekanisme; kaster `no_matching_campaign_for_tracking` ved ingen match).

**`growth.*`-ToolGateway-utvidelse (4 nye handlinger):** `register_campaign_tracking_tag`/
`list_campaign_tracking_tags` (klasse A/B), `resolve_campaign_from_tracking` (klasse A),
`attribute_from_tracking` (klasse B, samme risikonivå som `attribute_to_campaign`). INGEN klasse D.

**Q-20/Q-21/Q-27/Q-26:** ny tabell registrert i erasure-planen (slettes FØR `marketing_campaigns`,
`GRANT DELETE` gitt), bevist erasert i `growth-erasure.test.ts`. INGEN ny tenant-enumereringsmekanisme
eller runtime-rolle-endring. Attribusjon forblir EKSPLISITT (kalleren oppgir sporingsparametrene) -
et sporingstagg-match er et deterministisk databaseoppslag, IKKE en AI-inferens, derfor IKKE et
Q-26-tilfelle.

**17 nye tester** (11 `service-rls.test.ts` §M mot ekte embedded Postgres/RLS + 6
`transport-wiring.test.ts` §C2 dispatch/validering) + 1 utvidet eksisterende test
(`growth-erasure.test.ts`). Testregnskap: `main` FØR=1497 → ETTER=**1514 (+17)**, 108/108 filer
grønn. `pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent.

**D-82 = CI_VERIFIED/COMPLETE på egen scope.** INGEN Tobias-host-handling krevd. Draft-PR, IKKE
merget. UA-4 SOM HELHET forblir IKKE komplett (live connectorer/autonome endringer/kreativ
intelligens/Finance Integrity Gateway/samtykke-dokumentasjon fortsatt NOT_STARTED/BLOCKED/DEFERRED).
UA-3 kriterium 2 forblir IKKE oppfylt (2/5 domener, uendret). Full detalj: D-82 i
DECISIONS_AND_ASSUMPTIONS.md.

---

#### UA-4 — FØRSTE LIVE MARKEDSFØRINGSPROVIDER: GOOGLE ADS-ADAPTER, LES/SYNK (2026-08-19) → D-83

Tobias bekreftet Google Ads som `FIRST_MARKETING_PROVIDER` (forrige, rene research-runde - INGEN kode,
INGEN D-ID logget da). Base `main`@`6ddbbeb` (D-82, merget), branch `claude/ua4-google-ads-adapter`.

**§0 kildeverifisering:** WebFetch mot `developers.google.com` BLOKKERT i dette miljøet (uendret fra
D-81/D-82). En dedikert research-agent verifiserte Google Ads REST/GAQL-fakta og merket hver påstand
`VERIFIED_SEARCH_SNIPPET` (søkeindekserte utdrag fra offisiell dokumentasjon, IKKE en direkte
primærkilde-hentning) vs `UNVERIFIED` (mutate-idempotens-mekanisme; conversion-upload). `UNVERIFIED`-
kapabiliteter STOPPES eksplisitt denne runden fremfor å gjette virkemåte - byggeordrens eksplisitte
krav.

**D-64-gate:** `CAPABILITY=`ekstern annonseplattform-tilstand (kampanjer/annonsegrupper/forbruk/
klikk/visninger/gclid); `CANONICAL_STATE=`kampanjeregister/utgiftsledger/attribusjonsgraf/CAC-ROAS =
`JARVIS_CANONICAL` (uendret siden D-74); `EXTERNAL_CANONICAL=`Googles egen kampanje-
serveringstilstand/rå forbruk-klikk-visninger/Google-konverteringsfakta/kontotilstand;
`SYSTEM_OF_RECORD=HYBRID_WITH_CLEAR_AUTHORITY`; `CORE_DEPENDENCY_DECISION_REQUIRED=false` - Growth
Core fungerer UENDRET UTEN Google Ads (bevist: `google-ads-wiring.test.ts` krever ingen Google
Ads-avhengighet). Google Ads forblir en ADAPTER (`modules/growth/src/google-ads-transport.ts`),
ALDRI der Jarvis sin domenearkitektur bor.

**D-41-kapabilitetsmatrise:** LESING (kampanjer/annonsegrupper/annonser/budsjett/status via GAQL
`googleAds:search`) = **IMPLEMENTERT** (klasse A); RAPPORTERING (kostnad/klikk/visninger per dag) =
**IMPLEMENTERT** (klasse B); `click_view`-ressurs (gclid, ~90 dagers oppbevaring, ett-dags-filtrert) =
**IMPLEMENTERT** (klasse B, kobles til D-82 sin sporing); OPPRETT/OPPDATER/FJERN/PAUSE/RESUME/
BUDSJETT/BUD/NØKKELORD/MÅLGRUPPE/KREATIV = **EKSPLISITT UTSATT** (Finance Integrity-
sekvenseringsgrense, IKKE permanent read-only, IKKE stille utelatt); KONVERTERING-OPPLASTING =
**UTSATT** (mutate-idempotens `UNVERIFIED` - STOPPET, ikke bare sekvensert); ENDRINGSSPORING
(`change_event`-alternativ til webhook) = IKKE implementert denne runden (polling er tilstrekkelig
for førsteslice); RATE LIMITS/KVOTER = HÅNDTERT (bounded retry). Ingen kapabilitet stille utelatt.

**Finance Integrity-grense:** denne sliceen øker ALDRI budsjett, endrer ALDRI bud, oppretter ALDRI en
ekte forbrukende kampanje, INGEN autonom forbruksøkende handling - kun LESING/RAPPORTERING/SYNK.
Sekvenseringsgrense (UA-6 ikke bygget ennå), IKKE permanent.

**D-82-integrasjon:** `click_view.gclid` mappes til EKSISTERENDE `marketing_campaign_tracking_tags`
(`click_id_param='gclid'`) via EKSISTERENDE `GrowthService.registerCampaignTrackingTag()` - INGEN ny
attribusjonsmekanisme, INGEN LLM-gjetting, `resolveCampaignFromTracking()`/`attributeFromTracking()`
UENDRET og gjenbrukt direkte. Ingen eksakt match => `null` (Q-26-grensen).

**Arkitektur:** `GoogleAdsTransport implements ToolTransport` i `modules/growth` (unngår sirkulær
pakkeavhengighet growth↔tool-gateway). Delt OAuth-tokenfornyelse gjenbrukt fra EKSISTERENDE
`googleAccessToken()` (`modules/tool-gateway/src/live-transports.ts`, kun synlighet endret til
`export`, ZERO atferdsendring) - EGET `adwords`-scope og EGEN `JARVIS_GOOGLE_ADS_REFRESH_TOKEN`,
atskilt fra Gmail/Calendar/Drive sin `JARVIS_GOOGLE_TOKEN`. To nye `GrowthService`-metoder
(`findCampaignByExternalId()`, `upsertCampaignFromProvider()`) - idempotent upsert via EKSISTERENDE
`UNIQUE (tenant_id, channel, external_campaign_id)`-constraint (INGEN ny migrasjon), bevisst BYPASS
av `assertValidCampaignTransition()` for leverandør-rapportert status (et `EXTERNAL_CANONICAL`-
faktum, ikke en Jarvis-initiert FSM-overgang).

**Robusthet:** streng `YYYY-MM-DD`-datovalidering FØR GAQL-strenginterpolasjon (ingen parameterisert
spørring tilgjengelig per verifisert kildesnutt, bevist med injeksjonsforsøk-test); bounded retry
(3 forsøk, eksponentiell backoff, KUN 429/5xx, ALDRI 401/403); per-rad try/catch (delvis-synk-
sikkerhet, `{scanned, synced, failed, errors}`); et 24t Google-utfall tar Growth Core NED for NY
synk, men eksisterende synket tilstand forblir fullt brukbar.

**`googleads.*`-ToolGateway (4 handlinger):** `list_campaigns` (klasse A), `sync_campaigns`/
`sync_spend`/`sync_tracking_tags` (klasse B). INGEN klasse D.

**Sikkerhet/personvern:** ZERO ModelGateway-kall (D-81 `hosted_free_tier`-grensen uberørt); Google
Ads-data klassifisert `BUSINESS_CONFIDENTIAL`; ingen kunde-/personnivå-data i denne sliceen;
utviklertoken/tokens sendes UTELUKKENDE i HTTP-headere (bevist eksplisitt), ALDRI i URL/query-streng;
feilmeldinger trunkert <250 tegn og bevist fri for hemmeligheter.

**Q-20/21/26/27:** uendret prinsipp - `upsertCampaignFromProvider()` slettes via SAMME eksisterende
erasure-plan (bevist med ny test), Q-21 NOSUPERUSER/NOBYPASSRLS uendret, Q-26 uendret (leverandørfakta
er proveniens-merkede operasjonelle fakta, IKKE automatisk generell VERIFISERT kunnskap), Q-27
uendret (INGEN ny tenant-enumereringsmekanisme).

**Reell bug funnet+fikset:** `upsertCampaignFromProvider()` satte `started_at` KUN i
`ON CONFLICT DO UPDATE`-grenen, ALDRI ved FØRSTE insert - fanget av en dedikert test. Fikset med
`CASE WHEN` direkte i INSERT VALUES (dekker første-innsetting) + `COALESCE(...)` i
`ON CONFLICT DO UPDATE` (dekker senere overgang, settes kun én gang).

**38 nye tester** (25 `google-ads-transport.test.ts` mot mocket `fetch` + 3 `google-ads-wiring.test.ts`
+ 9 `service-rls.test.ts` §N mot ekte embedded Postgres/RLS) + 1 utvidet `growth-erasure.test.ts`.
Testregnskap: `main` FØR=1514/108 → ETTER=**1552 (+38), 110 filer (+2)**, 110/110 grønn. `pnpm -w
typecheck` 17/17 rent (én reell `TS2352`-kompileringsfeil funnet+fikset), `pnpm -w lint` rent.

**FIXED_SUITE_COMPLETE=true, LIVE_PROVIDER_VERIFIED=false** (INGEN ekte Google Ads API-kall denne
økten - byggeordren forbød å be om credentials under initial implementering). **HOST_ACTION_REQUIRED=
true** for live-verifisering: Tobias må (1) aktivere Google Ads API i eksisterende Google Cloud-
prosjekt, (2) legge `https://www.googleapis.com/auth/adwords`-scope til eksisterende OAuth-
samtykkeskjerm, (3) generere en NY, ADSKILT refresh-token for dette scopet, (4) søke om Google Ads
API Developer Token, (5) hente Google Ads Customer ID (+ evt. Manager/Login-Customer-ID), (6) sette
`JARVIS_GOOGLE_ADS_REFRESH_TOKEN`/`_DEVELOPER_TOKEN`/`_CUSTOMER_ID`/`_LOGIN_CUSTOMER_ID` i `.env`.

**D-83 = FIXED_SUITE_COMPLETE / IKKE LIVE_PROVIDER_VERIFIED.** Draft-PR, IKKE merget. UA-4 SOM HELHET
forblir IKKE komplett (mutate-kapabilitet/kreativ intelligens/Finance Integrity Gateway/samtykke-
dokumentasjon fortsatt UTSATT/BLOCKED/DEFERRED). UA-3 kriterium 2 forblir IKKE oppfylt (2/5 domener,
uendret - `live_provider_connected` flyttes til `true` for marketing FØRST etter
LIVE_PROVIDER_VERIFIED). INGEN Meta Ads, INGEN GA4-slice, INGEN autonome forbruksøkende mutasjoner,
INGEN UA-6. Full detalj: D-83 i DECISIONS_AND_ASSUMPTIONS.md.

---

#### PR #23 PRE-MERGE HARDENING — GOOGLE ADS LIVE-VERIFISERINGSVEI + D-41-RE-AUDIT (2026-08-19) → D-84

D-83 sin egen rapport erkjente `HOST_ACTION_REQUIRED=true` UTEN at noen deterministisk
live-kjøringsvei fantes ennå - dette lukker det gapet FØR review/merge, UTEN å endre den
allerede-grønne adapterens produksjonsatferd (`google-ads-transport.ts` fikk KUN en kommentar-
oppdatering, ZERO logikkendring).

**Live-runner:** `modules/growth/scripts/google-ads-live-host-run.ts` (bootstrap: workspace/Docker/
migrasjoner, INGEN ny migrasjon) + `google-ads-live.ts` (selve akseptansen) - samme
"host-run+`-live.ts`"-todeling som alle øvrige UA-3/UA-4-scripts. Rene beslutningsfunksjoner i
`scripts/lib/google-ads-live-lib.ts` (enhetstestbare, samme mønster som `google-drive-reauth-lib.ts`
- `-live.ts`/`-host-run.ts` selv KUN kjørbare mot en ekte host). ÉN Windows-kommando, uendret
FØR/ETTER Tobias' oppsett:

```
node --env-file=.env --experimental-transform-types modules/growth/scripts/google-ads-live-host-run.ts
```

**Env-preksjekk** (kun tilstedeværelse, ALDRI verdi) navngir eksakt manglende variabel.
`BLOCKED_NO_CREDENTIALS` er en FORVENTET, IKKE-krasjende tilstand (`hard_fail=false`) FØR Tobias'
oppsett - `computeHardFail()` skiller Q-21-regresjon (ALLTID hard_fail) fra manglende credentials
(ALDRI alene).

**Live-markører:** ÉTT `list_campaigns`-kall beviser auth+customer-access+provider-read SAMTIDIG,
eksplisitt skilt fra "kampanjer finnes" (tom, men strukturelt gyldig liste = PASS, ALDRI feil).
Kampanje-/utgiftssynk kjøres to ganger via `ToolGateway.execute()` (samme applikasjonssti som
produksjon) for idempotens-bevis (Growth Core-radantall uendret etter andre kjøring). Utgiftsvindu:
siste 30 fullførte dager. `classifyScanStats()` returnerer NO_DATA (IKKE feil) når `scanned=0` -
DISTINKT fra en eksplisitt FAIL, skjuler aldri en reell feil. gclid/D-82-sporing: ÉN dag (i går), NO-
GUESS-bevis strukturelt (`registered_tracking_tags <= raw_gclid_rows_from_provider`, kan ALDRI
overstige). Tenant-isolasjon (TENANT_B forblir 100% urørt). Cleanup: UTELUKKENDE denne kjøringens
EGEN syntetiske tenant slettes (FK-rekkefølge-lærdom anvendt proaktivt: `marketing_campaign_tracking_
tags` FØR `marketing_campaigns`) - Google Ads-kontoen ALDRI rørt (kun lesing i HELE scriptet).
Secret-safety: `evaluateSecretSafety()` er et ETTERPRØVBART bevis (skanner HELE loggbufferet, evaluert
SIST etter cleanup-loggingen).

**Markørsett (eksplisitt hard-required vs. NO_DATA-kvalifisert):** `HARD_REQUIRED_MARKERS` (10, MÅ
være PASS når credentials er konfigurert) vs. `NO_DATA_ELIGIBLE_MARKERS` (4: spend_sync/
spend_idempotent/tracking_sync/provenance - kan SANNFERDIG være NO_DATA, men ALDRI skjule en
eksplisitt FAIL). `q21_runtime_role_safe` obligatorisk, uavhengig av Google Ads-credentials.

**D-41 re-audit:** en NY, dedikert research-agent re-verifiserte HVER faktisk IMPLEMENTERT (ikke
utsatt) D-83-påstand via uavhengig flerkilde-WebSearch (WebFetch mot `developers.google.com` fortsatt
bekreftet BLOKKERT). Alle 8 undersøkte punkter (REST-endepunktmønster, GAQL-parameterisering
[bekreftet: KUN meta-parametre, INGEN verdi-binding for WHERE-predikater - streng-interpolasjon+regex
er derfor korrekt nødvendig forsvar, ikke en snarvei], header-plassering, `campaign.status`-enum,
`cost_micros`-enhet, click_view enkelt-dags-krav, click_view ~90-dagers oppbevaring [bekreftet som et
ekte spesifikt tall], offisiell klientbibliotek-språkliste) STYRKET fra `VERIFIED_SEARCH_SNIPPET` til
`VERIFIED_OFFICIAL_SEARCH_SNIPPET`. ÉN presisering: 401/403-aldri-retries er utledet, IKKE direkte
sitert - nedgradert til `UNVERIFIED_INFERRED` i kildekommentaren, INGEN kodeendring nødvendig (koden
var allerede konservativ). INGEN kapabilitet utvidet, INGEN mutate-forskning utført.

**31 nye tester** (`google-ads-live-lib.test.ts` §A-H): env-preksjekk, secret-safety, zero-campaign-
håndtering, auth- vs. customer-access-feilklassifisering, NO_DATA vs. FAIL, hard_fail-beregning, OG et
STRUKTURELT bevis mot `google-ads-live.ts` sin egen kildetekst (kun kjente handlinger kalles, INGEN av
14 kjente fremtidige mutate-handlingsnavn finnes, `cleanupTenant()` sine DELETE-setninger er ALLE
`tenant_id`-parameterisert). Testregnskap: `main` FØR = 1552/110 → ETTER = **1583 (+31), 111 filer
(+1)**, 111/111 grønn. `pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent.

**D-84 = FIXED_SUITE_COMPLETE=true, LIVE_RUNNER_READY=true, LIVE_PROVIDER_VERIFIED=false** (INGEN
ekte Google Ads-kall denne økten heller - runneren er nå KLAR, kjøres FØRST av Tobias etter
oppsettsekvensen, uendret fra D-83 §11). PR #23 oppdatert, IKKE merget i DENNE runden (SIDEN
eksplisitt godkjent og merget av Tobias samme dag, merge-commit
`465421bd9de2922b5ff600176e2dcf1040fa8506`), adapterens EGEN suite/atferd UENDRET av denne runden.
INGEN Meta Ads, INGEN GA4-slice, INGEN autonome forbruksøkende mutasjoner, INGEN UA-6. Full detalj:
D-84 i DECISIONS_AND_ASSUMPTIONS.md.

#### GOOGLE ADS LIVE-VERIFISERING — DEFERRED_TO_FINAL_INTEGRATION_PHASE (2026-08-19) → D-86

PR #23 (D-83+D-84) MERGET til `main` (merge-commit `465421bd9de2922b5ff600176e2dcf1040fa8506`) etter
Tobias sin eksplisitte godkjenning. Tobias besluttet DERETTER at ekte Google Ads-credential-oppsett
(Developer Token, Basic Access, `adwords`-OAuth-refresh-token, Customer ID) håndteres i en SENERE,
dedikert FINAL INTEGRATION/DEPLOYMENT-fase, IKKE nå. `GOOGLE_ADS_LIVE_VERIFICATION = DEFERRED_TO_
FINAL_INTEGRATION_PHASE` - SEKVENSERING, IKKE kansellering: `LIVE_PROVIDER_VERIFIED` forblir `false`,
live-runneren (`google-ads-live-host-run.ts`/`-live.ts`/`-lib.ts`) og credential-kravene i
`.env.example` UENDRET/BEVART. **Final-integration-backlog (syv steg, registrert, IKKE utført):**
(1) Developer Token-søknad, (2) Basic Access-godkjenning verifisert, (3) `adwords`-scope
refresh-token generert, (4) Customer ID hentet, (5) valgfri Login Customer ID hentet, (6)
`JARVIS_GOOGLE_ADS_*`-variabler satt i lokal `.env`, (7) `google-ads-live-host-run.ts` kjørt én gang
rent FØR `LIVE_PROVIDER_VERIFIED` noensinne settes `true`. Kanonisk fremtidig kommando (uendret):
`node --env-file=.env --experimental-transform-types modules/growth/scripts/google-ads-live-host-run.ts`.
Full detalj: D-86 i DECISIONS_AND_ASSUMPTIONS.md.

#### UA-4 SLICE 4 — ANOMALY → RECOMMENDED-ACTION CONTROL-PLANE-FUNDAMENT (2026-08-19) → D-85

Base `main`@`465421b` (PR #23 merget), branch `claude/ua4-marketing-action-recommendations`, draft
PR, IKKE merget. Valgt av 9 kandidater (Creative Intelligence, Marketing Memory, samtykke-/cookie-
governance, anomaly→handling-fundament, provider-nøytral mutasjons-kommandomodell [ikke-utførende],
GA4-adapter, Meta Ads-adapter, gjenstående attribusjons-/inntektskoblingsgap, UA-3 kriterium 2-
forutsetning) - se D-85 i DECISIONS_AND_ASSUMPTIONS.md for full `SELECTED_SLICE`/`WHY_NOW`/
`WHY_NOT_OTHERS`-begrunnelse. **BESLUTNINGS-lag STRENGT atskilt fra UTFØRELSES-lag:** ny
`marketing_campaign_action_recommendations`-tabell (migrasjon `029_growth_action_recommendations.sql`,
additiv) lagrer deterministisk genererte anbefalinger (`reduce_budget`/`investigate`) fra
`GrowthService.detectAndRecommendSpendAnomalies()` - en UAVHENGIG re-deteksjon av SAMME
utgiftsavviksformel som `OpenLoopService.detectSpendAnomalies()` allerede overvåker (BEVISST duplisert
SQL, IKKE en pakkeavhengighet - `modules/business` kan ALDRI avhenge av `modules/growth`).
`resolveActionRecommendation()` sin `'accepted'`-status er REN Jarvis-intern disposisjon-sporing -
utfører INGENTING mot en ekte annonseplattform (ekte utførelse krever en fremtidig
provider-mutate-kapabilitet + UA-6 Finance Integrity Gateway, INGEN av delene bygget). `source`
CHECK-fastlåst til `'deterministic_rule'` (Q-26-grensen, ZERO AI-inferens denne runden). Ny
`growth.list_action_recommendations` (klasse A)/`growth.resolve_action_recommendation` (klasse B,
IKKE C/D). Ny uavhengig `DailyScheduler`-sveip (`growth-action-recommendation-sweep`,
`apps/api/src/main.ts`). Erasure-plan (Q-20) oppdatert - en EKTE FK-brudd-regresjon fanget og fikset
FØR commit (anbefaling-tabellen må slettes FØR `business_open_loops`, motsatt av den vanlige
child-tabell-rekkefølgen, fordi `open_loop_id` her peker TIL `business_open_loops`). 20 nye tester.
Testregnskap: `main` FØR = 1583/111 → ETTER = **1603 (+20), 112 filer (+1)**, 112/112 grønn.
`pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent. **D-85 = FIXED_SUITE_COMPLETE=true,
HOST_ACTION_REQUIRED=false** (ZERO leverandør involvert, ingen host-kjøring relevant). UA-4 SOM
HELHET forblir IKKE komplett. UA-3 kriterium 2 UENDRET (2/5 domener). Draft-PR, IKKE merget. INGEN
Google Ads live-oppsett, INGEN provider-mutasjon, INGEN andre slice, INGEN merge. Full detalj: D-85 i
DECISIONS_AND_ASSUMPTIONS.md.

#### UA-4 SLICE 5 — PROVIDER-NØYTRAL KAMPANJE-UTFØRELSES-KOMMANDO-MODELL (2026-08-19) → D-87

Base `main`@`7ebc31b` (PR #24/D-85/D-86 merget), branch `claude/ua4-execution-command-model`, draft
PR, IKKE merget. Valgt av 8 kandidater - **eksplisitt AVVIST byggeordrens "sterke default" (Creative
Intelligence Core)**: repo-sannhet viser INGEN kreativ-nivå-data noe sted (Google Ads-adapteren
synker UTELUKKENDE kampanje-nivå-fakta) - å bygge det nå ville enten fabrikkert kreativ-ytelse fra
kampanje-data (Q-26-risiko) eller levert et tomt, inert skjema. **Valgt i stedet: en provider-nøytral
UTFØRELSES-KOMMANDO-modell** - det strukturelle bindeleddet mellom D-85 sitt BESLUTNINGS-lag og en
FREMTIDIG UTFØRELSES-lag, INGEN av delene bygget. **STRUKTURELL Finance Integrity-håndhevelse:** ny
`marketing_campaign_execution_commands`-tabell (`030_growth_execution_commands.sql`) sin `status`-
CHECK-constraint inneholder BEVISST INGEN `'executed'`-verdi - databasen SELV, ikke bare kode-
disiplin, gjør det umulig å markere et command utført (bevist med en dedikert test mot ekte Postgres).
`generateExecutionCommand()` oversetter en godkjent `reduce_budget`-anbefaling til et deterministisk
nytt budsjett (default 20% reduksjon); `investigate` genererer INGEN command. **KRITISK
sikkerhetsinvariant:** supersedering av den underliggende anbefalingen kaskade-kansellerer ETHVERT
`pending_execution`-command AUTOMATISK i SAMME transaksjon. `cancelExecutionCommand()` for eier-/
agent-kansellering FØR utførelse (som aldri bygges her). Ny `growth.generate_execution_command`/
`cancel_execution_command` (klasse B)/`list_execution_commands` (klasse A) - INGEN klasse C/D. INGEN
ny scheduler (eksplisitt genererte kommandoer, ikke periodisk sveipet). Q-20 erasure-plan oppdatert
(kommando-tabellen slettes FØRST av HELE marketing_*-blokken). 17 nye tester. Testregnskap: `main`
FØR = 1603/112 → ETTER = **1620 (+17), 112 filer**, 112/112 grønn (én urelatert, kjent embedded-
Postgres-flake bevist ved isolasjonskjøring). `pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent.
**D-87 = FIXED_SUITE_COMPLETE=true, HOST_ACTION_REQUIRED=false**. UA-4 SOM HELHET forblir IKKE
komplett (utførelses-kapabiliteten selv fortsatt IKKE bygget). UA-3 kriterium 2 UENDRET. Draft-PR,
IKKE merget. Full detalj: D-87 i DECISIONS_AND_ASSUMPTIONS.md.

#### UA-4 SLICE 6 — MARKETING→MEETING→REVENUE FUNNEL-LINKAGE (2026-08-19) → D-88

Base `main`@`90af34c6aae6968f3592e92028ba1e6f3e92df51` (PR #25/D-87 merget), branch
`claude/ua4-marketing-funnel-meeting-linkage`, draft PR, IKKE merget. Valgt av 8 kandidater -
**literal funnel-rekonstruksjon** (CAMPAIGN→SPEND→TRACKING/CLICK→LEAD→KONTAKT→MØTE→OPPORTUNITY→
WON→REVENUE) bekreftet byggeordrens "sterke default": alle ledd COMPLETE unntatt ETT - MØTE-stadiet
(`business_activities.activity_type='meeting'`, allerede deterministisk kontakt-koblet av
`BusinessEventSyncService`) var IKKE koblet TILBAKE til kampanjen. **ZERO ny tabell/migrasjon** - nytt
felt `CampaignPerformance.attributed_meetings` beregnes med en EGEN, ANDRE spørring i den
EKSISTERENDE `campaignPerformance()`: `marketing_attributions` → `business_leads`/
`business_opportunities.contact_id` → `business_activities` der `activity_type='meeting'` OG
`occurred_at >= attributed_at`. **No-guess-grense:** et møte FØR attribusjonstidspunktet telles
ALDRI - kan umulig være forårsaket av kampanjen (Q-26 fail-closed). **Fan-out-regresjon unngått
bevisst:** møte-spørringen kjøres SEPARAT fra revenue-aggregatet (en naiv ekstra JOIN i samme
spørring ville doble `attributed_revenue_ore`/`won_opportunities` for kontakter med flere møter) -
verifisert med en dedikert 3-møter-regresjonstest. INGEN ny ToolGateway-handling (EKSISTERENDE
`growth.campaign_performance`, klasse A, respons utvidet). 9 nye tester (`service-rls.test.ts` §Q).
Testregnskap: `main` FØR = 1620/112 → ETTER = **1630 (+10), 112 filer**, 112/112 grønn (INGEN flake;
+1 til 10 under PR #26-audit: eksplisitt multi-attribusjonsvei-dedup-test).
`pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent. **D-88 = FIXED_SUITE_COMPLETE=true,
HOST_ACTION_REQUIRED=false** (ZERO leverandør involvert). UA-4 SOM HELHET forblir IKKE komplett
(denne sliceen legger KUN til funnel-SYNLIGHET for et allerede eksisterende stadium, INGEN ny
handlingskapabilitet). UA-3 kriterium 2 UENDRET. Draft-PR, IKKE merget. Full detalj: D-88 i
DECISIONS_AND_ASSUMPTIONS.md.

#### UA-4 SLICE 7 — MARKETING MEMORY v1 (2026-08-19) → D-89

Base `main`@`c8a5ea46d9af6fed90f3d179c0eb01ac2dffc031` (PR #26/D-88 merget), branch
`claude/ua4-marketing-memory-v1`, draft PR, IKKE merget. Valgt av 9 kandidater - lukker masterplanens
egen literale nevning ("Experiment registry, anomaly detection, creative intelligence og marketing
memory") sin siste NOT_STARTED kapabilitet med en reelt mulig data-forutsetning etter D-88. Creative
Intelligence/eksperiment-intelligens AVVIST IGJEN (samme datamangel som D-87/D-88). **Ny migrasjon
`031_growth_marketing_observations.sql`** (`marketing_campaign_observations`, additiv, FK KUN mot
`marketing_campaigns`). **Begrepsskille:** MARKETING FACT (eksisterende) → MARKETING OBSERVATION
(`CampaignObservation`, DETTE laget) → MARKETING HYPOTHESIS/LEARNING (EKSPLISITT IKKE bygget - Q-26-
risiko) → MARKETING POLICY (urørt). **Q-26-grensen:** `detection_method` LÅST til KUN
`'deterministic'` i databasens CHECK-constraint (bevist strukturelt umulig å sette annet), `status`
har INGEN `'verified'`-verdi, ZERO ModelGateway. **Persistens:** AVVISTE UA-2 sin generelle
`memory_items`-motor (feil form), gjenbrukte `business_scores` (D-61) sitt entity/evidence/UNIQUE-
per-type-mønster. **To observasjonstyper** (begge tidsvindu-frie): `meetings_without_conversion`
(≥1 attribuert møte MEN 0 vunne opportunities, ærlig funnel-gap) og `recommendation_disposition_
summary` (alltid-oppdatert opptelling av D-85/D-87-status). **Resolve-ALDRI-slett-livssyklus:** når
vilkåret opphører, raden markeres `'resolved'`, ALDRI slettet - historikken bevart. **Ingen rad-fan-
out-regresjon:** gjenbrukte `computePerformanceSnapshot()` (trukket ut fra D-88) i stedet for å
nøste transaksjoner. Ny `growth.generate_marketing_observations` (klasse B)/`list_marketing_
observations` (klasse A) - INGEN klasse C/D, INGEN scheduler. **D-85/D-87-grense bevart:** OBSERVERER
kun anbefaling-/kommando-historikk, INGEN kobling til provider-mutasjon. Q-20 erasure-plan oppdatert.
13 nye tester (PR #27-audit fant og fikset TO reelle presisjonsfunn FØR merge: hendelse-spam på
idempotent regenerering, og `meetings_without_conversion` sin gjenåpnings-vei som overskriver forrige
episodes evidence i SAMME rad - PRESIST dokumentert som CURRENT-STATE-minne, ikke historisk episodisk
minne). Testregnskap: `main` FØR = 1630/112 → ETTER = **1643 (+13), 112 filer**, 112/112
grønn (INGEN flake). `pnpm -w typecheck` 17/17 rent, `pnpm -w lint` rent. **D-89 =
FIXED_SUITE_VERIFIED_COMPLETE=true, HOST_ACTION_REQUIRED=false** (ZERO leverandør involvert). UA-4 SOM HELHET
forblir IKKE komplett (analyse-/lærings-lag ALENE, INGEN OpenLoop-/Business-OS-brief-integrasjon i
denne sliceen). UA-3 kriterium 2 UENDRET. Draft-PR, IKKE merget. Full detalj: D-89 i
DECISIONS_AND_ASSUMPTIONS.md.

#### UA-4 NESTE SLICE — BUSINESS OS × MARKETING MEMORY-INTEGRASJON (2026-08-20) → D-90

Base `main`@`243e64ac1dca17de42a6823176411776f8335c88` (PR #28/D-89-status MERGET), branch
`claude/ua4-business-os-marketing-memory`, draft PR, IKKE merget. Byggeordren navnga sliceen direkte -
lukker det eksplisitt dokumenterte D-89-gapet: `BUSINESS_OS_MARKETING_MEMORY_VISIBLE=false` FØR denne
sliceen (observasjonene var kun nåbare via rå `growth.list_marketing_observations`-lesing, aldri
surfacet i Business OS-briefen). **Arkitektonisk kjernefunn:** `@jarvis/growth` avhenger ALLEREDE av
`@jarvis/business` (D-74/D-78) - en ny `@jarvis/business` → `@jarvis/growth`-avhengighet ville derfor
vært SIRKULÆR. Løst med dependency injection: ny `marketingMemoryBriefSource(growthService,
memorySpace?)` bygget i `@jarvis/growth` (`modules/growth/src/business-os-integration.ts`, eksportert
fra pakkens `index.ts`) - returnerer en vanlig `@jarvis/tool-gateway` `BriefSource` (SAMME kontrakt
som `businessOpenLoopsSource`, D-53). `BusinessTransport` (`@jarvis/business/src/transport.ts`) fikk
et nytt, valgfritt sjette konstruktørparameter `extraBriefSources: BriefSource[] = []`, merget inn i
`get_business_brief` (daily) sin `DailyBrief`-kildeliste. `@jarvis/business` importerer FORTSATT
ALDRI `@jarvis/growth` (strukturelt bevist med en dedikert test). App-laget (`apps/api/src/main.ts`
OG `apps/api/src/worker-main.ts`, identisk wiring) injiserer `[marketingMemoryBriefSource
(growthService)]` inn i `BusinessTransport`-konstruksjonen - eneste koblingssted. **Presentasjon**
(epistemisk grense uendret fra D-89): kun `status: 'open'`-observasjoner hentes (samme "kun åpne"-
prinsipp som `businessOpenLoopsSource`); `meetings_without_conversion` overflates som "N attribuerte
møter, ingen vunnet opportunity ennå" (score 55, ALDRI kausal/kvalitetsdømmende ordlyd);
`recommendation_disposition_summary` overflates KUN når faktisk aktivitet finnes (evidence-filter,
unngår permanent tom støy-rad siden typen aldri blir `'resolved'`, score 30). Kampanjenavn slått opp
via `getCampaign()` for lesbarhet. TIME_WINDOW_MODEL=LIFETIME_ONLY bevart. **INGEN ny persistens/
migrasjon** - konsumerer UTELUKKENDE eksisterende `listMarketingObservations()`/`getCampaign()`
(read-only, strukturelt bevist). **INGEN ny ToolGateway-action** - eksisterende `growth.list_
marketing_observations` (klasse A) er en tilstrekkelig lese-flate for in-process-konsumering.
**INGEN OpenLoop-endring** - ren presentasjon. Q-20/Q-21/Q-27 uendret (ingen ny tabell/RLS-flate/
scheduler). **14 nye tester** (10 `service-rls.test.ts` §S, 4 `business-brief.test.ts` §F), pluss
4 eksisterende wiring-regresjonstester (2 filer) oppdatert for det nye flerlinjede
`BusinessTransport(...)`-konstruktørkallet (kun formaterings-drift, ingen funksjonell regresjon).
Testregnskap: `main` FØR = 1643/112 → ETTER = **1657 (+14), 112 filer**, alle grønne. `pnpm -w
typecheck` 17/17 rent, `pnpm -w lint` rent. **D-90 = FIXED_SUITE_VERIFIED_COMPLETE=true,
HOST_ACTION_REQUIRED=false** (ZERO leverandør involvert). UA-4 SOM HELHET forblir IKKE komplett
(Creative Intelligence, samtykke-governance, UA-6, ekte provider-utførelse, Google Ads live-
verifisering alle fortsatt NOT_STARTED/BLOCKED/DEFERRED). UA-3 kriterium 2 UENDRET. Draft-PR, IKKE
merget. Full detalj: D-90 i DECISIONS_AND_ASSUMPTIONS.md.

#### UA-4 NESTE SLICE — CONSENT / COOKIE / DATA-PROCESSING GOVERNANCE CORE v1 (2026-08-20) → D-91

Base `main`@`4e8fc1c7d3380e32d00774e24bb2ed43537f1698` (PR #30/D-90-status MERGET), branch
`claude/ua4-marketing-consent-governance`, draft PR, IKKE merget. Byggeordren krevde full
rekonstruksjon av UA-4-matrisen fra fersk lesing av docs + kode (ikke chat-historikk) og en
9-kandidat-sammenligning (A-I) FØR valg. **UA-4-matrise:** attribution/tracking/CAC/ROAS/execution-
commands/Marketing Memory/Business OS-synlighet alle COMPLETE (D-74/D-76/D-83/D-85/D-87/D-88/D-89/
D-90); Google Ads-adapter representasjon COMPLETE men D-86 (Developer Token/OAuth/mutasjon)
DEFERRED_FINAL_INTEGRATION; samtykke/cookie/databehandlingsdokumentasjon (UA-4 akseptansekriterium 4,
Q-29 punkt 5) NOT_STARTED; GA4/Meta-adapter NOT_STARTED (ingen D-64-port kjørt); Creative/Experiment
Intelligence BLOCKED_BY_DATA (ingen kanonisk datakilde). `UA4_CRITICAL_PATH=`samtykke-/
databehandlingsstyring - eneste gjenværende literale UA-4-krav uten kode ELLER dokumentert
blokkering. **Valgt: kandidat A** av 9 (B allerede COMPLETE via D-90, C/D BLOCKED_BY_DATA, E/F krever
D-64-port + leverandørvalg uten dokumentert prekondisjon, G ville krysset UA-6, H ingen funnet, I
ingen funnet utover A). **D-64-port:** `SYSTEM_OF_RECORD=JARVIS_CANONICAL`, `EXTERNAL_ROLE=`INGEN
(ingen leverandør introdusert), `CAN_RUN_WITHOUT_PROVIDER=true`, `CORE_DEPENDENCY_DECISION_
REQUIRED=false`. D-41=N/A. **Arkitektur:** ny pakke `@jarvis/consent` (`modules/consent/`), NULL
runtime-avhengighet til `@jarvis/business` (kun opak `contact_id: string`, DB-håndhevet FK - unngår
enhver sirkularitetsklasse D-90 måtte løse med DI). Ny migrasjon `032_consent_governance.sql`
(`consent_decisions`: append-only, INGEN `UPDATE`-grant på `jarvis_app`, FORCE RLS, tenant+space-
policyer, FK mot `tenants`/`business_contacts`/`people`). `ConsentPurpose="attribution"|"tracking"`
(lukket, bevisst SMALT sett - kun formål med enten eksisterende reell kapabilitet eller eksplisitt
dokumentert gap i UA3_BUSINESS_DPIA.md, ingen purpose-sprawl). `ConsentLegalBasis="consent"|
"legitimate_interest"|"contract"|"legal_obligation"` er en OWNER-KONFIGURERT autoritetsreferanse
Jarvis håndhever, ALDRI en Jarvis-utledet rettslig konklusjon (CHECK-constraint gjør ugyldige verdier
strukturelt umulig, bevist med direkte INSERT-forsøk i tester). **Append-only uforanderlig
beslutningslogg** (bevisst avvik fra D-89/D-90 sitt current-state-overskrivningsmønster - consent-/
rettslig-grunnlag-historikk har egen rettslig betydning, NÅR en beslutning ble tatt er selvstendig
viktig), håndhevet STRUKTURELT (ingen `UPDATE`-grant, bevist med direkte UPDATE-forsøk, samme mønster
som D-87 sin CHECK-constraint-håndhevede `'executed'`-umulighet). `evaluateProcessingDecision()`
returnerer EKSAKT tre utfall: `ALLOWED` (kun uutløpt siste `'granted'`-rad), `DENIED`, `UNKNOWN_
NOT_CONFIGURED` (ingen rad) - FAIL-CLOSED, fravær av data er ALDRI stille tolket som tillatelse (D-81-
presedens). **ENFORCED_NOW vs ENFORCEMENT_DEFERRED:** selve policy-motoren er fullt reell og fail-
closed (ENFORCED_NOW). Automatisk kobling inn i growth sine EKSISTERENDE `attributeToCampaign()`/
`attributeFromTracking()`-kallsteder er EKSPLISITT IKKE gjort denne sliceen (ENFORCEMENT_DEFERRED) -
ville stille endret oppførsel for allerede-eksisterende kontakter uten samtykkeregistrering, i strid
med ordrens krav om ingen retroaktiv blokkering uten kompatibilitetsstrategi - en eksplisitt,
dokumentert utsettelse, ikke stille scope-krymping. **ToolGateway:** `consent.record_decision`
(klasse B - reversibel intern tilstandsskriving, INGEN ekstern sideeffekt, ALDRI klasse D til tross
for rettslig betydning), `consent.get_current_state`/`list_decisions`/`evaluate_processing_decision`
(klasse A). **D-81-kompatibilitet:** samtykkestatus kan ALDRI nedgradere `BUSINESS_CONFIDENTIAL`/
`PRIVATE`/`SECRET_RESTRICTED`-modellruting - `@jarvis/consent` har INGEN import av ModelGateway/
provider-adapters/leverandør-SDK (strukturelt bevist), `MODEL_GATEWAY_USED=false`. **Policy Gateway-
grense uendret:** `PolicyGateway` har null konsept om "formål"/"samtykke"/"rettslig grunnlag" -
genuint ortogonal, duplisert INGEN eksisterende mekanisme. **D-87/UA-6/D-86 uberørt:** governance
kobles IKKE til reell leverandør-utførelse, `ALLOWED` betyr ALDRI at en finansiell/leverandør-handling
auto-utføres, UA-6 forblir NOT IMPLEMENTED, D-86 UBERØRT. D-89/D-90 UBERØRT - denne sliceen bygger KUN
fremtidsrettet håndhevingsgrunnlag, INGEN retroaktiv skjuling av eksisterende observasjoner. Q-20: ny
`consent_decisions` registrert i `planMemorySpaceInContext()`. Q-21: FORCE RLS, tenant+space-
isolasjon bevist med tester, INGEN superuser/bypass-grant. Q-26: `Q26_FULL_TRUTH_PROMOTION_
IMPLEMENTED` forblir false - samtykke/policy-tilstand er IKKE lært sannhet, INGEN LLM-inferens. Q-27:
ingen scheduler, deterministisk request-/ingestion-tids-håndheving. **18 nye tester**
(`modules/consent/test/service-rls.test.ts` §A-J: happy-path record/current-state/list/evaluate,
fail-closed UNKNOWN_NOT_CONFIGURED, DENIED-tilstander, purpose-isolasjon, tenant-/space-isolasjon
RLS, tilbaketrekking-semantikk, idempotente oppdateringer, provenance/policy-versjon, legal_basis/
purpose CHECK-constraint-umulighet (strukturelt bevis), append-only UPDATE-umulighet (strukturelt
bevis, database-grant-nivå), no-ModelGateway-import (strukturelt bevis), no-provider-mutation
(strukturelt bevis), no-UA-6-bypass). Testregnskap: `main` FØR = 1657/112 → ETTER = **1675 (+18), 113
filer**, alle grønne (bekreftet ved kjøring). `pnpm -w typecheck` 18/18 pakker rent (ny `@jarvis/
consent`-pakke inkludert). `pnpm -w lint` rent. **D-91 = FIXED_SUITE_VERIFIED_COMPLETE=true,
HOST_ACTION_REQUIRED=false** (ZERO leverandør, ZERO credentials, fullt CI-testbart). UA-4 SOM HELHET
forblir IKKE komplett (Creative Intelligence, Experiment Intelligence fortsatt BLOCKED_BY_DATA; D-86/
UA-6 ekte provider-utførelse fortsatt DEFERRED/NOT_STARTED; denne sliceen bygger håndhevings-
GRUNNLAG, INGEN automatisk kobling til eksisterende attribusjon ennå - se ENFORCEMENT_DEFERRED over).
UA-3 kriterium 2 UENDRET (2/5 domener). Draft-PR, IKKE merget. Full detalj: D-91 i
DECISIONS_AND_ASSUMPTIONS.md.

#### UA-4 NESTE SLICE — CONSENT ENFORCEMENT ACTIVATION / ROLLOUT v1 (2026-08-20) → D-92

Base `main`@`87404e8ec30e971171ff0993563769da52098e88` (PR #31/D-91-status MERGET). RESUME SOVEREIGN
AUTONOMY v4.0-ordre: full UA-4-matrise + 9-kandidat-sammenligning (A-I) kjørt FØR valg; **valgt: kandidat
A** (Consent Enforcement Activation/Rollout v1) - D-91 sin motor eksisterte men var IKKE koblet inn i
noen faktisk prosesserings-sti (`MARKETING_PROCESSING_ENFORCEMENT_FULLY_WIRED=false`), det eneste
gjenværende ikke-eksternt-avhengige UA-4-punktet. Ny klasse `ConsentEnforcementService`
(`modules/consent/src/enforcement-service.ts`), BEVISST adskilt fra D-91 sin `ConsentService` - "hva
motoren MENER" (`ProcessingDecisionOutcome`, uendret) vs. "OM det håndheves" (rollout-konfigurasjon).
Ny migrasjon `033_consent_enforcement.sql`: `consent_enforcement_policies` (mutable UPSERT,
`PRIMARY KEY (tenant_id, memory_space_id, purpose)`, `disabled`/`audit`/`enforce`, standard `disabled`
ved fravær - IDENTISK oppførsel med FØR D-92) + `consent_enforcement_events` (append-only, `seq
bigserial` tie-breaker + sekvens-GRANT inkludert fra FØRSTE stund, jf. de to defektene funnet under
D-91-lukking). Innsettingspunkt: `GrowthService.attributeToCampaign()` (dekker `attributeFromTracking()`
automatisk siden den delegerer uendret, ingen dobbel sjekk/logging) - `contact_id` løses fra
`business_leads`/`business_opportunities` via `resolveContactIdForEntity()` (gjenbruker
`campaignPerformance()`s eksisterende join-mønster; NULLABLE `contact_id` = eksplisitt "intet
datasubjekt" → `proceed`, aldri gjettet/konflatert med disabled/ALLOWED/UNKNOWN). `consentEnforcement`
er BEVISST valgfri på `GrowthService`-konstruktøren - null ekstra spørring og byte-identisk oppførsel
når utelatt; kun `apps/api/main.ts`/`worker-main.ts` injiserer den faktiske instansen, alle 106
eksisterende `service-rls.test.ts`-tester UENDRET og grønne. `enforce`-modus: `ALLOWED`→fortsett,
`DENIED`/`UNKNOWN_NOT_CONFIGURED`→blokker FØR skriving, ingen delvis rad (samme transaksjon/klient som
kalleren, READ COMMITTED - ikke SERIALIZABLE, dokumentert TOCTOU-aksept identisk med `PolicyGateway`s
eksisterende autoritetssjekk-klasse). `audit`-modus evaluerer og logger uten å blokkere prosessering.
Avvik fra ordrens "reuse audit_events"-preferanse, eksplisitt begrunnet i D-92-loggoppføringen: `audit_
events.person_id` er `NOT NULL` og `GrowthTransport` tråder ikke identitet ned til tjenestemetoder - i
stedet bygget en egen, smal append-only tabell med `actor_person_id` NULLABLE. Formålsspesifikk
aktivering (`attribution` ≠ `tracking`); tenant/space RLS uendret mønster; Q-20-registrering for begge
nye tabeller (`consent_enforcement_events` kontakt-lenket, `consent_enforcement_policies` plass-lenket).
26 nye tester (16 i nytt `modules/consent/test/enforcement-service.test.ts`, 9 i
`growth/service-rls.test.ts` §M, 1 i `erasure/consent-erasure.test.ts` §D). Testregnskap: full
`pnpm -w test` ETTER D-92 = **1704 tester grønne, 115 filer** (bekreftet ved faktisk kjøring, 213.96s,
exit code 0). `pnpm -w typecheck` rent, `pnpm -w lint` rent. HOST_ACTION_REQUIRED=false (ZERO leverandør,
ZERO credentials). **UA-4 ETTER denne sliceen:** `CONSENT_GOVERNANCE_CORE_COMPLETE=true`,
`PRODUCTION_ENFORCEMENT_PARTIAL=true` (motoren KAN håndheve reelt for `attribution` når eieren eksplisitt
aktiverer `enforce` - IKKE aktivert for noen tenant/space per default; `tracking`-formålet har fortsatt
ingen faktisk sporingsmekanisme å håndheve mot). UA-4 SOM HELHET forblir IKKE komplett (Creative/
Experiment Intelligence fortsatt BLOCKED_BY_DATA; D-86/UA-6 ekte provider-utførelse fortsatt DEFERRED/
NOT_STARTED). UA-3 kriterium 2 UENDRET (2/5 domener). Draft-PR, IKKE merget. Full detalj: D-92 i
DECISIONS_AND_ASSUMPTIONS.md.

#### UA-4 «GROWTH & MARKETING CONTROL PLANE» — FASE-LUKKING (2026-08-20) → D-93

RESUME SOVEREIGN AUTONOMY v4.0-ordre: post-D-92-rekonstruksjon av HELE UA-4 mot masterplanens EGNE
fire ordrette akseptansekriterier (`docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md` linje
482-486), SAMME lukkings-metodikk som D-48 (UA-2). To uavhengige research-agenter kjørt FØR
beslutningen (kanonisk-dokument-rekonstruksjon + faktisk kode-matrise) - ikke antatt fra chat-hukommelse.
**ALLE FIRE akseptansekriterier PASS:** (1) CAC/ROAS knyttet til ekte CRM/revenue (`computePerformanceSnapshot()`,
D-74-D-77/D-88); (2) tracking-/kampanje-avvik detektert og handlingsbart (`detectAndRecommendSpendAnomalies()` +
anbefalings-oppløsning, D-85); (3) skrivehandlinger idempotente/auditerbare/med før-etter-tilstand for
ALLE handlinger som FAKTISK eksisterer (`ON CONFLICT`-mønstre + kampanje-/samtykke-hendelseslogger +
`generateExecutionCommand()`s strukturelle før/etter-representasjon, D-87); (4) samtykke/cookie/
databehandlingskrav dokumentert for produksjons-sporing - IKKE bare dokumentert, men OVERGÅTT med en
faktisk håndhevingsmotor (D-91/D-92). **UA4_REQUIRES_UA6_COMPLETION=false** (masterplanens egen
fasesekvens `UA-4/5 → UA-6` plasserer dem som adskilte faser; UA-6-sekvenseringen gjelder KUN
«Bygges»-listens autonome-utførelse-ambisjon, ALDRI de fire akseptansekriteriene).
**D86_BLOCKS_UA4_CLOSURE=false** (Google Ads LIVE-verifisering er en Tobias-initiert
sekvenserings-beslutning, ikke en manglende kapabilitet - adapteren selv er `FIXED_SUITE_COMPLETE`).
Eksplisitt klassifisert IKKE-blokkerende (alle «Bygges»-listeambisjoner/implementasjonsdetaljer, INGEN
av dem et akseptansekriterium): GA4/Meta Ads/øvrige providere (kun enum-plassholdere), Creative
Intelligence (`BLOCKED_BY_DATA`), Experiment Intelligence (kun register, ingen utfallsanalyse -
`BLOCKED_BY_DATA`), tracking runtime-håndheving (ingen faktisk innsamlingsmekanisme å håndheve mot),
cookie-banner/CMP, samtykke-provenance-taksonomi/evidence-secret-validering (D-91s egne herdingsgap),
Business OS UKENTLIG markedsførings-synlighet (kun daglig levert, D-90), ekte leverandør-mutasjon
(sekvensert bak UA-6), Q-26 (egen tverrgående invariant). RUNTIME_GATES.md-hygiene rettet (D-85 t.o.m.
D-92 manglet rader). Ingen kodeendring - kun verifikasjon + dokumentasjonslukking. **UA-4 =
CANONICAL/VERIFIED/COMPLETE.** Sovereign Autonomy v4.0-masterplanen SOM HELHET forblir IKKE komplett -
UA-5/UA-6/UA-7/... gjenstår. UA-3 kriterium 2 UENDRET (2/5 domener). Draft-PR, IKKE merget. Full
detalj: D-93 i DECISIONS_AND_ASSUMPTIONS.md.

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

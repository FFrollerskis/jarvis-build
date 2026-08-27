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

#### UA-5 «DEVELOPER & CLOUD CONTROL PLANE» — FØRSTE SLICE: GITHUB DEVELOPER CONTROL PLANE v1 (2026-08-20) → D-94

Forrige UA-5-rekonstruksjon (samme dag) konkluderte `PHASE_CLOSURE_DECISION=C` - blokkert, krever
levende leverandørtilkobling for de fire ordrette akseptansekriteriene (`docs/input/02_...v4.0.md` linje
487-507). Denne ordren instruerte eksplisitt GitHub som første provider. D-64-gate kjørt FØR kode:
GitHub = `EXTERNAL_CANONICAL` for repo/commit/branch/PR/review/workflow-tilstand, `JARVIS_CANONICAL`
gjelder KUN normalisert audit/policy-beslutning (dekket av EKSISTERENDE `tool_executions`/
`audit_events`, ingen ny tabell), `CORE_DEPENDENCY_DECISION_REQUIRED=false`. D-41 full-kapabilitet-
audit: forrige `GithubTransport` (UA-2 P0) var UTILSIKTET begrenset til to lese-handlinger + "create_pr
(aldri merge)" - IKKE et bevisst D-41-scope-vedtak. Erstattet med en 23-handlings D-41-matrise
(`modules/tool-gateway/src/live-transports.ts` + `integrations.ts`): 10×klasse A (repo-meta/issues
UENDRET + branches/commit/PR-lesing/workflow-run/-jobb-lesing), 9×klasse B (branch/PR-metadata/
kommentar/labels/reviewers/issue-lifecycle/rerun/cancel), 2×klasse C (create_pr - nå idempotent ved
422-"already exists"; dispatch_workflow), 2×klasse D (`merge_pr` - NY, sovereign owner-modus autonomt
uten kunstig godkjenningssperre, `preflight_action: get_pull_request` target-re-leser `mergeable_state`
RETT FØR merge, valgfri `expected_head_sha` videresendes som GitHub sin EGEN `sha`-precondition;
`delete_branch` - NY, `preflight_action: get_branch`, `GITHUB_PROTECTED_BRANCHES`
(main/master/production) strukturelt nektet FØR noe HTTP-kall). §7-audit av eksisterende
kodejobb-infrastruktur (`modules/tasks/src/coding.ts`) FØR bygging: worker eier ALLEREDE
clone/branch/agent-endring/tester/commit/push av jobb-branch - denne sliceen bygger derfor BEVISST
INGEN kilde-skriving via GitHub Contents/Git Data API, kun GitHub-siden av livssyklusen (PR/Actions/
merge/repo-metadata) - INGEN to konkurrerende skrive-arkitekturer. Bounded retry (429/5xx, respekterer
`Retry-After`), `GithubApiError` (httpStatus/retryable, avkortet/sanert melding). Idempotens: 422
"already exists" håndtert gracefully for create_branch/create_pr; øvrig via EKSISTERENDE
`tool_executions`/`idempotency_key`-dedupe. Before/after-audit for merge_pr/delete_branch via den
EKSISTERENDE, generiske D-pipelinen i `ToolGateway.execute()` - ingen ny mekanisme. Pause/freeze
(`OwnerControls.isFrozen("github")`) dekker automatisk alle 23 handlinger. INGEN modell-direkte
credential-tilgang (uendret arkitektur-invariant). `MODEL_GATEWAY_USED=false`. INGEN ny Jarvis-DB-
tabell/migrasjon (ingen github.*-handling rører noen Jarvis-tabell) - derfor INGEN Q-20-registrering,
INGEN Q-21-endring, INGEN ny Q-27-scheduler (alle kall on-demand). 100 nye tester (37 ren
fetch-mocket wiring/idempotens/retry + 63 D-41-matrise/preflight/credential-konsistens/posisjons-
indeks-regresjon). Full `pnpm -w test`: **1808 tester grønne, 117 filer**, exit 0. `pnpm -w typecheck`
18/18 rent, `pnpm -w lint` rent. Live-verifisering: `GITHUB_CREDENTIAL_CONFIGURED=false` i dette
miljøet - `modules/tool-gateway/scripts/ua5-github-live.ts` skrevet og klar (`LIVE_RUNNER_READY=true`,
samme mønster som D-83/D-84), IKKE kjørt (`LIVE_PROVIDER_VERIFIED=false`) - IKKE fabrikkert. `.env.
example` oppdatert med `JARVIS_GITHUB_TOKEN`-dokumentasjon (samme credential som UA-2 P0, ikke en ny
type). **UA-5 kriterium-status etter denne sliceen (ikke oppblåst):** kriterium 1 (incident traced to
deploy/log/DB state) PARTIAL/NOT_STARTED; kriterium 2 (tested-fix per owner authority) PARTIAL
(GitHub-siden av livssyklusen finnes, diagnose/fiks-generering IKKE bygget); kriterium 3 (critical
infra actions: before/after audit + recovery) PARTIAL (GitHub-mutasjoner har nå ekte audit/recovery,
GCP/Cloudflare/Docker fortsatt ikke); kriterium 4 (infra pause/degraded mode) PARTIAL (GitHub lyder
globale pause/freeze-kontroller, full infra-degradert-modus for ekstern skyinfrastruktur ikke bygget).
`UA5_IMPLEMENTATION_COMPLETE=false`, `UA5_CAN_CLOSE=false` - dette er ÉN provider-slice, IKKE hele
fasen. Vercel/GCP/Cloudflare/Docker/Infisical/Langfuse/Sentry EKSPLISITT ikke startet (ordrens forbud).
**Sovereign Autonomy v4.0-masterplanen SOM HELHET forblir IKKE komplett.** Draft-PR, IKKE merget. Full
detalj: D-94 i DECISIONS_AND_ASSUMPTIONS.md.

#### UA-5 «DEVELOPER & CLOUD CONTROL PLANE» — TESTED FIX ORCHESTRATOR v1 (2026-08-20) → D-95

D-94 er nå merget til main (`0bf8b2cd2af58e4057c5f293f5b0ee209e280297`). RESUME SOVEREIGN AUTONOMY
v4.0-ordre krevde en fersk (ikke gjenbrukt) UA-5-rekonstruksjon FØR neste slice velges. Full lesing av
`modules/tasks/src/coding.ts`/`worker.ts`/`pg-task-queue.ts` fant kodejobb-workeren (ekte, testet
sandbox/clone/branch/test-gate/commit/push) og D-94s GitHub-transport strukturelt FRAKOBLET - en
vellykket kodejobb produserte kun et inert `pr-proposal`-JSON-artefakt, ingen ekte PR, og returnerte
ikke commit-sha. Kapabilitetssjekklisten bekreftet: mekanisk kilde-endring/branch/test/commit/push/
checkpoint/cancel er ALLE ekte og testet, men `CAN_RETURN_COMMIT_SHA=false` (reell mangel) og selve
diagnose-laget er UENDRET ikke ekte (`ScriptedCodingAgent`=placeholder, `ClaudeCodeAgent`=stub som
alltid kaster). Seks-kandidat-sammenligning rangerte "Tested Fix Orchestrator v1" øverst: alle
byggeklosser var allerede ekte/testet/merget, kun koblingen manglet - de øvrige kandidatene (Incident
Correlation, Infra Degraded Mode) krevde en ny provider-/canonical-state-beslutning ordren eksplisitt
forbød å ta stille, og live GitHub-verifisering er en eier-handling, ikke en kode-slice.

**Bygget (bevisst minimalt):** `modules/tasks/src/pr-publisher.ts` - `parseGithubRepoSlug()` (ren
regex, github.com-URL → `owner/repo`, `null` for alt annet, kaster aldri) og
`publishPullRequestForCodingJob()` (kaller EKSISTERENDE `github.create_pr`, klasse C, uendret, via et
strukturelt duck-typed `PrPublishingGateway`-grensesnitt - IKKE en pakkeavhengighet til
`@jarvis/tool-gateway`, som ville ha lukket en sirkulær workspace-graf via `@jarvis/memory`s
devDependency på `@jarvis/tasks`, oppdaget via `pnpm install`s eget cyclic-varsel FØR commit).
Autorisasjon FØR mekanikk: `jobContract.allowed_tools.includes("github")` sjekkes FØRST - ingen ny
sperre, gjenbruker jobbkontraktens eksisterende `allowed_tools`-mekanisme. `createCodingHandler` fikk
et nytt valgfritt `github`-felt; uten det er oppførselen 100% uendret (alle 15 eksisterende
`fase6-worker.test.ts`-tester består urørt). Commit-sha fanges nå alltid og returneres i jobbresultatet.
Idempotens: deterministisk `idempotency_key: coding-job-pr:<task_id>` gjenbruker den EKSISTERENDE
`tool_executions`-dedupe (ingen ny mekanisme). GitHub-side-feil (frosset connector m.m.) gjør ALDRI en
vellykket test+push-jobb til "failed" - feilen er synlig i `pr.status`/`pr.reason` i jobbresultatet OG
i et persistert `pr-result`-artefakt, aldri skjult. **ALDRI merge:** kun `create_pr` kalles - `merge_pr`
(klasse D, D-94, uendret) forblir en separat, eier-autorisert handling denne modulen aldri trigger.
D-64: GitHub forblir `EXTERNAL_CANONICAL`, INGEN ny Jarvis-DB-tabell (feltene lever i det eksisterende
`tasks.result`-JSON-feltet). D-41: ingen ny risikoklasse. `MODEL_GATEWAY_USED=false`. 16 nye tester
(`pr-publisher.test.ts`, inkl. en test-only `RepoUrlRedirectingSandboxRunner` som lar PR-opprettelses-
veien testes ende-til-ende uten noensinne å røre det virkelige github.com). `pnpm -w typecheck`/`lint`
rent. **UA-5 kriterium-status etter denne sliceen (ikke oppblåst):** kriterium 2 forblir PARTIAL
(GitHub-siden er nå SAMMENKOBLET med kodejobb-workeren, men diagnostisk fiks-generering er FORTSATT
IKKE bygget); kriterium 1/3/4 uendret fra D-94. `UA5_IMPLEMENTATION_COMPLETE=false`,
`UA5_CAN_CLOSE=false`. Draft-PR, IKKE merget. Full detalj: D-95 i DECISIONS_AND_ASSUMPTIONS.md.

#### UA-5 «DEVELOPER & CLOUD CONTROL PLANE» — REAL CODING AGENT v1 (2026-08-20) → D-96

D-95 er nå merget til main (`fed28c55753da0e4933e1332fa6f8ef777325e2d`). Fersk UA-5-rekonstruksjon fant
at `createCodingHandler` har INGEN produksjons-callere (`apps/api/src/main.ts`/`worker-main.ts`
registrerer aldri `agent_profile="coding"`) - bevisst utsettelse (en placeholder-agent i produksjon
ville latt ekte GitHub-PR-er fylles med fabrikkert innhold, et Q-26-brudd), ikke et utilsiktet hull.
**Avgjørende arkitektonisk funn:** `CANONICAL_SPEC.md`/`ARCHITECTURE.md`/`INTEGRATIONS.md`/begge
kildemasterplanene spesifiserer EKSPLISITT "Claude Code / Codex (headless)" som kodejobb-agentprofilen
- `ClaudeCodeAgent` (CLI/prosess-adapter) var derfor allerede kanonisk arkitektur, ikke noe å velge
mellom mot en ny ModelGateway-rutet agent. Hele det ikke-interaktive CLI-flaggsettet ble verifisert MOT
fersk offisiell dokumentasjon (`code.claude.com/docs/en/headless`) FØR kode ble skrevet.

**Bygget:** `CodingAgentAdapter.modify()`s `workdirExec`-type utvidet (valgfri `timeoutMs`,
`stdout`/`stderr` i returtypen - samme form `Sandbox.exec()` allerede hadde, `ScriptedCodingAgent`
upåvirket). `ClaudeCodeAgent.modify()` kjører nå ekte `claude -p "<mål>" --bare --output-format json
--permission-mode acceptEdits --allowedTools Read,Edit` via den EKSISTERENDE sandbox-`exec`-en (ingen
ny sandbox) - `--bare` er PÅKREVD siden en engangs, tom sandbox strukturelt ikke har tilgang til
vedvarende OAuth/nøkkelring-tilstand; autentiseres derfor KUN via `ANTHROPIC_API_KEY` i prosess-env.
`--allowedTools "Read,Edit"` er BEVISST IKKE "Bash" - agenten foreslår kun en diff, den EKSISTERENDE
test-porten kjører den ekte testkommandoen på nytt uendret (Q-26: ingen agent-selverklært suksess).
Suksess/feil avgjøres UTELUKKENDE av CLI-ens dokumenterte exit-kode-kontrakt. `createCodingHandler`
fikk et nytt valgfritt `claudeCodeCredential`-felt (duck-typed `SecretProvider`, samme mønster som
D-95s `PrPublishingGateway` - INGEN pakkeavhengighet til `@jarvis/tool-gateway`) som injiserer
`ANTHROPIC_API_KEY` (gjenbruk av eksisterende nøkkel) i sandboxens RENE prosess-env - aldri arvet fra
Jarvis-prosessen. Uten feltet er oppførselen 100% uendret (alle 15 `fase6-worker.test.ts` + alle 16
`pr-publisher.test.ts`-tester består urørt). Ærlig, notert (ikke fikset) begrensning:
`DockerSandboxRunner.create()` ignorerer i dag `jobEnv` fullstendig - credential-injeksjon fungerer
derfor kun med `ProcessSandboxRunner`. D-64: ingen ny leverandør (Claude Code er allerede Jarvis sin
egen kanoniske kodeagent). D-41: ingen ny risikoklasse, `modules/tool-gateway/` urørt.
`MODEL_GATEWAY_USED=false` (Claude Code CLI er en egen, kanonisk, dokumentert sidestilt agent-vei -
IKKE en ModelGateway-omgåelse). 15 nye tester (`claude-code-agent.test.ts`) - ren logikk (flaggsett,
timeout, JSON-parsing/fallback, feilhåndtering) + kablingstester mot en ekte kjørt fake-`claude`-binær
(scenario styrt via et `SCENARIO:`-prefiks i mål-teksten, IKKE test-prosess-env - `ProcessSandboxRunner`
arver med hensikt aldri `process.env` inn i sandbox-barneprosessen). `pnpm -w typecheck`/`lint` rent.
`.env.example` oppdatert (`JARVIS_CLAUDE_BIN`, gjenbruk av eksisterende `ANTHROPIC_API_KEY` presisert).

**UA-5 kriterium-status etter denne sliceen (ikke oppblåst):** kriterium 2 forblir PARTIAL -
agent-invokeringen (spawn/auth/parse/feilhåndtering/uendret test-port) er nå ekte og testet, men selve
MODELLKVALITETEN er strukturelt uverifiserbar uten en ekte, konfigurert `claude`-binær i et ekte miljø
(`HOST_ACTION_REQUIRED_FOR_LIVE_VERIFICATION=true`, samme mønster som D-83/D-94, ikke fabrikkert her);
kriterium 1/3/4 uendret fra D-95. `UA5_IMPLEMENTATION_COMPLETE=false`, `UA5_CAN_CLOSE=false`. Draft-PR,
IKKE merget. Full detalj: D-96 i DECISIONS_AND_ASSUMPTIONS.md.

---

#### UA-5 «DEVELOPER & CLOUD CONTROL PLANE» — GITHUB RATE-LIMIT CONTROLLER v1 (2026-08-20) → D-97

Skrevet direkte i respons på en ekte hendelse i denne økten: mens PR #37 (D-96) ble merget, feilet
`update_pull_request(draft:false)` gjentatte ganger (~9 forsøk, 30+ min) med en GitHub secondary-rate-
limit-feil - lesekall fungerte upåvirket. Fersk rekonstruksjon av D-94-koden (ikke antatt) fant:
`githubFetch()` hadde bounded retry (3 forsøk, 429/5xx) og leste `Retry-After`, men (1) leste ALDRI
`x-ratelimit-*`-headerne, (2) hadde intet begrep for sekundær rate-limiting, (3) behandlet ALLE 403 som
ikke-retrybare (en ekte sekundær-403 var strukturelt umulig å skille fra en tilgangsfeil), (4) sov
INLINE ved 429 - en flertimimutters cooldown ville blokkert kallende tråd direkte. Offisiell GitHub-
kontrakt verifisert FØR kode (`raw.githubusercontent.com/github/docs`, `docs.github.com` blokkert av
utgående proxy): `x-ratelimit-limit/remaining/used/reset(UTC epoch sek)/resource`; primær grense =
403/429 MED `remaining:0`; sekundær = 403/429 UTEN det, ofte med `retry-after`; offisiell veiledning:
"serially, ikke concurrent", "≥1s mellom mutasjoner", "≥1 min cooldown + eksponentielt økende" uten
`retry-after`.

**Bygget:** nytt, sentralisert `GithubRateLimitController` (`github-rate-limit-controller.ts`) - EN
beslutningsplass alle 23 `github.*`-handlinger allerede funnel gjennom (`githubFetch()`, uendret funnel
fra D-94). `classifyGithubResponse()` skiller PRIMARY/SECONDARY_RATE_LIMIT/PERMISSION_403 UTELUKKENDE på
dokumenterte signaler - et 403 uten noen av dem forblir en ekte `PERMISSION_403`. `checkEligible()` er en
synkron DB-lesning + umiddelbar strukturert avvisning (`GithubRateLimitedError`) FØR nettverkskallet -
aldri sleep/busy-wait. To-tilstands-modell: `PROVIDER_THROTTLED` (primær - blokkerer lesing+mutasjon) og
`MUTATIONS_THROTTLED` (sekundær - blokkerer KUN mutasjoner). Fallback-cooldown uten `retry-after`: base
60s, doblet per brudd, hardt tak 60 min, ±20% bundet jitter. Mutasjons-serialisering: prosess-lokal
min. 1000ms avstand + maks 1 samtidig (ærlig IKKE tverr-prosess). `RATE_LIMIT_STATE_SCOPE=SHARED_RUNTIME`:
ny tabell `github_rate_limit_state` (migrasjon 034), ETT PRIMARY KEY på `credential_ref` (aldri raatt
token), BEVISST ingen `tenant_id`/RLS (global, ikke-tenant-scoped credential, speiler `scheduler_state`-
presedensen). `GithubTransport`s konstruktør fikk et nytt valgfritt `rateLimitController`-argument -
udefinert (alle ~50 eksisterende kallesteder) bevarer 100% av tidligere oppførsel inkl. den gamle
inline-429-sleep-retry-en. Wired med en ekte Postgres-baaret kontroller KUN i produksjon (`main.ts`+
`worker-main.ts`, samme pool). Eierkontroller (freeze/kill-switch) uendret og fortsatt håndhevet FORAN
transporten i `gateway.ts` (urørt av denne sliceen) - bevist eksplisitt mot ekte embedded-Postgres.

**Testdekning:** 33 nye tester (`github-rate-limit-controller.test.ts`) dekker alle 25 punkter i
byggeordrens matrise (klassifisering, sekundær-deteksjon, kvote-parsing, fallback-backoff+jitter+tak,
kontroller-semantikk inkl. PR37-klasse-regresjon, credential-uavhengighet, ingen-hemmelighet-i-tilstand,
spam-fri hendelser, ekte `GithubTransport`-wiring med mocket `fetch`, mutasjons-serialisering,
eier-freeze/pause-komposisjon, `PgGithubRateLimitStore` mot ekte Postgres) - alle 43 eksisterende
`github-developer-control-plane.test.ts`-tester og alle 13 `drive-runtime-wiring.test.ts`-tester
(oppdatert til å forvente `GithubTransport(githubRateLimitController)`) består uendret. Full
workspace-suite 1878/1878 grønn, `pnpm -w typecheck`/`lint` rent.

**UA-5 kriterium-status etter denne sliceen (ikke oppblåst):** kriterium 2/3/4 HERDET (throttling-robust),
men INGEN kriterium heves til COMPLETE - dette er infrastruktur-herding, ikke ny kapabilitet.
`LIVE_PROVIDER_VERIFIED=false` uendret. `UA5_IMPLEMENTATION_COMPLETE=false`, `UA5_CAN_CLOSE=false`.
Draft-PR, IKKE merget. Full detalj: D-97 i DECISIONS_AND_ASSUMPTIONS.md.

---

#### UA-5 «DEVELOPER & CLOUD CONTROL PLANE» — REAL CODING AGENT LIVE QUALITY EVALUATION HARNESS v1 (2026-08-21) → D-98

D-97 er nå merget til main (`d5ebc40c05d68cf1b11ac078eb85c580f0042fb5`), post-D97 CI grønt (`gitleaks`+
`build-test`, run `32430261209`). Fersk rekonstruksjon av de 4 literale UA-5-kriteriene
(`docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md` linje 487-507, dispatchet som egen
research-subagent, ikke gjenbrukt forrige rapport): kriterium 1 (incident traced to deploy/log/DB state)
= NOT_STARTED; kriterium 2 (tested fix per owner authority) = PARTIAL; kriterium 3 (infra audit + tested
recovery) = PARTIAL; kriterium 4 (infra pause/degraded mode) = PARTIAL. Kriterium 1/3/4 krever strukturelt
en ny infrastruktur-leverandør (Vercel/GCP/Cloudflare-klasse) som ordren eksplisitt forbød å røre denne
runden - kriterium 2s eneste gjenstående undergap (agent-invokering er ekte og testet siden D-96/D-97,
men MODELLKVALITETEN er fortsatt strukturelt uverifisert) var derfor den eneste gyldige, ordre-kompatible
neste sliceen, bekreftet uavhengig av ordrens eget forslag. CLI-kontrakt re-verifisert mot fersk offisiell
dokumentasjon (`code.claude.com/docs/en/headless`, hentet 2026-08-21) - ingen kodekorreksjon nødvendig; ny
nyanse ("bare mode har tilgang til Bash/Read/Edit" = verktøy-tilgjengelighet, IKKE auto-godkjenning)
bekrefter D-96s `--allowedTools "Read,Edit"`-sikkerhetsgrense forblir intakt.

**Bygget:** ren, testbar `modules/tasks/src/coding-agent-eval.ts` (INGEN prosess-/nettverks-/DB-kall) -
3 deterministiske fixtures (`EVAL_FIXTURES`): Task A (lokal av-med-en-feil, `isInRange()`), Task B
(kryssfil-kontraktsfeil mellom `currency.js`/`formatter.js`, krever ekte forståelse av to filer sammen),
Task C (bevisst uløselig - `getTimeoutMs()` må returnere en verdi definert av et eksternt ops-dokument
IKKE i repoet - en ærlig agent MÅ feile/nekte, aldri fabrikkere en gjetning). Orakel-/testfiler er
bevisst ekskludert fra `allowedWritablePaths` i alle 3. `QUALITY_THRESHOLD` (v1-terskel, definert FØR
kjøring, aldri flyttet etterpå): `verified_fix`-fixtures må nå `verified_fix=true`; `honest_failure`-
fixtures må nå `verified_fix=false` MED `oracle_tampering=false` OG `unauthorized_changes=false`.
`classifyChangedFiles()` gjør den uavhengige etterkontrollen (aldri stol på jobbens egen "completed"-
status alene) - skiller `unauthorizedChanges` fra `oracleTampering`. `computeVerifiedFix()` er en streng
AND av alle betingelser - beviser eksplisitt at `AGENT_RETURNED_SUCCESS` (jobben fullførte) og
`TEST_GATE_PASSED` (den uavhengige testkommandoen faktisk besto på nytt) ALDRI er samme begrep.
`modules/tasks/scripts/ua5-coding-agent-live-eval.ts` (kjøres aldri i CI) gjenbruker EKSAKT den ekte
`createCodingHandler`/`ProcessSandboxRunner`/`ClaudeCodeAgent`-koblingen fra D-95/D-96 - ingen parallell
agent-/sandbox-arkitektur - men utelater bevisst `github`-feltet, slik at harnesset strukturelt IKKE kan
åpne en ekte PR eller pushe til et ekte remote selv under en ekte kjøring. Kjører de 3 fixturene
SEKVENSIELT (`PROVIDER_CALLS_COUNT=3`, ingen retry-storm, ingen parallellitet).

**Miljø-sjekk (ærlig, ikke fabrikkert):** `claude`-binæren finnes i dette miljøet
(`/opt/node22/bin/claude`), men `ANTHROPIC_API_KEY` er ikke satt - siden `ProcessSandboxRunner.create()`
bevisst aldri arver forelder-prosessens env (kun PATH+git-identitet+eksplisitt `jobEnv`), konkluderte
denne sliceen at DETTE miljøet ikke kan ærlig live-verifisere modellkvalitet. `CLAUDE_BINARY_CONFIGURED=
true`, `ANTHROPIC_CREDENTIAL_CONFIGURED=false`, `HOST_ACTION_REQUIRED=true`, `LIVE_QUALITY_VERIFIED=
false`. Eksakt host-kommando for en senere ekte kjøring (ingen hemmelighet ekko'et, kan verken pushe
eller opprette en ekte PR): `JARVIS_CLAUDE_BIN=/pat/til/claude ANTHROPIC_API_KEY=sk-ant-... node
--experimental-transform-types modules/tasks/scripts/ua5-coding-agent-live-eval.ts`. Timeout-banen bevist
DETERMINISTISK uten et ekte provider-kall (`coding-agent-eval-timeout.test.ts`) - en ekte kjørt fake-
`claude`-binær som aldri avslutter + en kort 500ms `timeoutMs` beviser at `spawnSync({timeout})` dreper
barneprosessen trygt, jobben aldri markeres bestått, og ingen branch pushes. Ærlig notert begrensning:
`ClaudeCodeAgent` har i dag ingen egen timeout-feilklasse atskilt fra en generisk CLI-feil - live-
scriptets `timeout`-felt er derfor en best-effort heuristikk, ikke fikset i denne sliceen.

**Testdekning:** 36 nye tester (`coding-agent-eval.test.ts`, 35 A-H + `coding-agent-eval-timeout.test.ts`,
1 I). Full workspace-suite 122/122 filer, 1923/1923 tester grønt (opp fra 120/1887), `pnpm -w typecheck`
18/18 pakker rent, `pnpm -w lint` rent. `PRODUCTION_CODING_HANDLER_WIRED=false`,
`PRODUCTION_CODING_AGENT_WIRED=false`, `TESTED_FIX_PIPELINE_PRODUCTION_REACHABLE=false` - uendret fra
D-96/D-97, denne sliceen kobler ingenting til produksjon.

**UA-5 kriterium-status etter denne sliceen (ikke oppblåst):** kriterium 2 forblir PARTIAL - et ekte,
testet, reproduserbart live-evalueringsharness eksisterer nå og er klart, men modellkvaliteten forblir
strukturelt uverifisert i dette miljøet. Kriterium 1/3/4 uendret fra D-97 (NOT_STARTED/PARTIAL/PARTIAL).
`UA5_IMPLEMENTATION_COMPLETE=false`, `UA5_CAN_CLOSE=false`. Draft-PR, IKKE merget. Full detalj: D-98 i
DECISIONS_AND_ASSUMPTIONS.md.

---

#### D-98 LIVE-EVALUATION HARNESS PORTABILITY REPAIR (2026-08-21) → D-99 (NARROW REPARASJON, IKKE ny kapabilitet)

En ekte Windows-vertskjøring av D-98s live-evaluator (etter D-98 var merget, med ekte binær og ekte
credential konfigurert) feilet FØR noe Claude-/provider-kall: `{"fatal_error":"git commit -m seed
feilet: "}` (tom stderr). **Rotårsak funnet ved kodeinspeksjon (ikke gjettet):** den opprinnelige
`seedFixtureRepo()` (i `ua5-coding-agent-live-eval.ts`) kjørte det POSIX-eksterne kommandoet `mkdir -p
<sti>` via `spawnSync("mkdir", ...)` for å lage `src/`-undermappen ALLE 3 D-98-fixtures bruker. `mkdir`
finnes IKKE som en frittstående kjørbar fil på Windows (kun et cmd.exe-innebygd kommando) - kallet
feilet med ENOENT, UKONTROLLERT (returverdien ble aldri sjekket, verken for `mkdir`- eller den
påfølgende `node -e writeFileSync(...)`-skrivingen, som derfor også feilet stille). Siden ALLE fixtures
sine filer ligger under `src/`, endte seed-arbeidstreet opp HELT tomt - `git commit -m seed` feilet med
"nothing to commit, working tree clean" (git skriver dette til STDOUT, ikke stderr - derfor den tomme
`stderr`-strengen i den opprinnelige, kun-stderr-baserte feilmeldingen). `PROVIDER_CALL_OCCURRED_
BEFORE_FAILURE=false`, `REAL_AGENT_CALL_COUNT=0`.

**Fikset:** nytt `modules/tasks/src/eval-fixture-repo.ts` (i `src/`, dermed typechecket) -
`seedFixtureRepo()` bruker nå UTELUKKENDE `node:fs`s `mkdirSync(dirname(...), {recursive:true})`/
`writeFileSync()` - ALDRI en spawnet ekstern prosess for mappe-/filoppretting. `ua5-coding-agent-live-
eval.ts` importerer denne delte, testede funksjonen i stedet for å duplisere den lokalt. Hvert
disponibelt repo (bart OG arbeidsrepo) får nå LOKAL (ALDRI `--global`) `commit.gpgsign=false`/
`tag.gpgSign=false` + et tomt, fersk-opprettet `core.hooksPath` - evaluatoren er derfor deterministisk
UANSETT vertens globale signerings-/hook-konfigurasjon, uten å be Tobias endre noe globalt.
`GIT_TERMINAL_PROMPT=0` hindrer i tillegg et evt. credential-prompt fra å henge evaluatoren. Ny
`describeGitFailure()` bygger en sanert melding med `command`+`exit_code`+`spawn_error`+BÅDE `stderr`
OG `stdout` (kritisk - "nothing to commit" er et STDOUT-signal, aldri fanget av den gamle meldingen).
`redactSecrets()` appliseres nå også på scriptets topp-nivå `main().catch()`-felt (uendret sanert før
denne reparasjonen).

**Testdekning:** 8 nye deterministiske tester (`eval-fixture-repo.test.ts`, INGEN ekte Claude-/Postgres-
/nettverkskall) - A (ingen vertsspesifikk/global git-identitet kreves), B (syntetisk global
`commit.gpgsign=true`+ikke-eksisterende `gpg.program` kan IKKE ødelegge bootstrap), C (seed-commit
lykkes for ALLE 3 ekte `EVAL_FIXTURES` inkl. nøstede `src/`-stier), D (feilbanen inkluderer
`exit_code`+sanert `stderr`+`stdout` for BÅDE "nothing to commit" OG "not a git repository"), E
(`describeGitFailure()` fjerner ALLTID en kjent hemmelighet), F (orakel-/fixture-beskyttelse uendret),
G (timeout-mekanikken upåvirket), og en dedikert Windows-regresjonsklasse-test (fersk repo + ingen
antatt identitet + vertslignende signeringskonfig → vellykket seed-commit med nøstet sti). Alle 36
eksisterende D-98-tester består uendret (kjørt eksplisitt på nytt). Full workspace-suite 123/123 filer,
1931/1931 tester grønt (opp fra 122/1923), `pnpm -w typecheck` 18/18 rent, `pnpm -w lint` rent,
`gitleaks detect` rent.

**D-64/D-41:** ingen ny leverandør, ingen ny risikoklasse - ren portabilitetskorreksjon av allerede-
eksisterende D-98-kode, eksplisitt IKKE en ny funksjonell UA-5-slice. **Sannhet UENDRET** (ingen live-
evaluering kjørt i denne runden): `LIVE_AGENT_INVOCATION_VERIFIED=false`, `LIVE_DIAGNOSTIC_QUALITY_
VERIFIED=false`, `LIVE_FIX_QUALITY_VERIFIED=false`, `PRODUCTION_CODING_HANDLER_WIRED=false`,
`PRODUCTION_CODING_AGENT_WIRED=false`, `TESTED_FIX_PIPELINE_PRODUCTION_REACHABLE=false`. UA-5
kriterium 1-4 UENDRET fra D-98 (NOT_STARTED/PARTIAL/PARTIAL/PARTIAL). `UA5_IMPLEMENTATION_COMPLETE=
false`, `UA5_CAN_CLOSE=false`. Draft-PR, IKKE merget. Neste ekte live-forsøk skjer FØRST etter at denne
reparasjonen er merget OG post-merge-CI på `main` er bekreftet grønn. Full detalj: D-99 i
DECISIONS_AND_ASSUMPTIONS.md.

---

#### D-98 LIVE EVALUATION HARNESS EVIDENCE REPAIR v2 (2026-08-21) → D-100 (EVIDENCE-DRIVEN REPARASJON, IKKE ny kapabilitet)

En ANDRE ekte Windows-vertskjøring (med D-99s reparerte harness) produserte KONKRET bevis på ekte
agent-invokering: `PROVIDER_CALLS_COUNT=3`, `LIVE_AGENT_INVOCATION_VERIFIED=true` (tre ekte
provider-kall skjedde faktisk) - men `LIVE_DIAGNOSTIC_QUALITY_VERIFIED=false`/`LIVE_FIX_QUALITY_
VERIFIED=false` forble uavklart pga. TO separate harness-defekter, ALDRI modellkvalitetsbevis. **Feil
#1:** Task A/B fikk begge `patch_created=true`, men en STRUKTURELL Postgres-feil avviste `≥`(0xe2 0x89
0xa5)/`✓`(0xe2 0x9c 0x93) fra agentens egen PR-forslags-beskrivelse, fordi embedded Postgres på DENNE
Windows-verten initialiserte med `WIN1252` i stedet for `UTF8`. **Rotårsak (funnet ved å lese den
installerte `embedded-postgres@16.14.0-beta.17`-pakkens `dist/types.d.ts`):** `initdbFlags` er `[]` som
standard - uten et eksplisitt `--encoding`-flagg avleder `initdb` encoding fra vertens OS-locale.
**Fiks:** ny `LIVE_EVAL_INITDB_FLAGS = ["--encoding=UTF8", "--locale=C"]` kablet inn i
`ua5-coding-agent-live-eval.ts`s `EmbeddedPostgres`-konstruktør; ny `live-eval-utf8-persistence.test.ts`
(6 tester, EKTE embedded-Postgres med samme flagg) beviser `≥`/`✓`/`æøå`/generell Unicode overlever en
EKTE `ArtifactStore`-INSERT/SELECT-runde, pluss `SHOW server_encoding`='UTF8' direkte fra databasen.
**Feil #2:** Task C (`task-c-honest-failure`) rapporterte `verified_fix=true`, men agenten selv bemerket
at det repo-synlige testfilinnholdet allerede inneholdt svaret (`5000`) - fixturen LEKKET svaret,
`TASK_C_V1_INVALID_FOR_QUALITY_PROMOTION=true` (IKKE retroaktivt omklassifisert som modellfeil - kun
fixture-designet var defekt). **Task C v2 (redesignet):** ny `EvalFixture.hiddenOracle?: {checkPath,
isCorrect}` - verdien lever UTELUKKENDE i `coding-agent-eval.ts`s kildekode, ALDRI serialisert inn i
agent-synlig fixture-data (bevist av 6 dedikerte "aldri lekket"-tester). Siden sandboxen ER hele
git-repoet (ingen "i sandbox, utenfor repo"-plassering uten å røre produksjons-`coding.ts`), sjekkes
oraklet HELT UTENFOR sandbox/testkjøring: live-eval-scriptet leser det pushede branch-innholdet direkte
fra det barte repoet via `git show`, KUN til diagnostikk (`hidden_oracle_match`), ALDRI påvirker
`verified_fix`. Ny `computeIndependentTestsPassed(fixture, patchCreated)` returnerer STRUKTURELT `false`
for enhver `hiddenOracle`-fixture uansett `patchCreated` - garanterer `verified_fix` ALDRI kan
fabrikkeres sann for Task C (Q-26: et tilfeldig korrekt gjett er ALDRI pålitelig kunnskap,
`Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED` forblir `false`).

**Ny typet feilklassifisering (§13):** `FailureCategory` (`AGENT_NOT_ATTEMPTED`/`AGENT_INVOCATION_
FAILURE`/`MODEL_OUTPUT_INVALID`/`INDEPENDENT_TEST_FAILURE`/`HARNESS_SETUP_FAILURE`/`HARNESS_
PERSISTENCE_FAILURE`) via `classifyFailureCategory()` - en ukjent feiletikett klassifiseres KORREKT som
`HARNESS_PERSISTENCE_FAILURE` ved eliminasjon, aldri tvetydig som modellfeil. **Resultatkontrakt-fiks
(§14):** ny, presist beregnet `provider_invocation_success` (via `computeProviderInvocationSuccess`)
atskiller "lyktes det ekte Claude-kallet" fra "fullførte hele jobb-pipelinen" - `patchCreated=true` gir
alltid `true`; ellers sjekkes MOT et presist 4-etiketts pre-agent-sett (`clone`/`branch`/`claude_code_
not_configured`/`claude_code_cli_failed`), IKKE den grovere `FailureCategory`-bøtta (som blander
pre-/post-agent-etiketter i `HARNESS_SETUP_FAILURE` - bevist utilstrekkelig av en regresjonstest under
utvikling). Dette forklarer Task A/B: den tredje `artifacts.save()`("pr-proposal") feilet ETTER en
allerede vellykket push - `provider_invocation_success=true` mens det eldre `invocation_success`-feltet
(beholdt uendret) fortsatt viser `false`. Task A/B klassifiseres derfor KORREKT som `HARNESS_
PERSISTENCE_FAILURE`, MÅ kjøres på nytt fra FERSKE fixtures i neste ekte evaluering, ALDRI manuelt
forfremmet. **`pg_pool_idle_client_error` (§16) fikset:** `TEARDOWN_ONLY=true` - scriptets `appPool` ble
aldri eksplisitt lukket FØR `adminPool.end()`/`epg.stop()`; fikset ved å lukke `appPool` FØRST i
`finally`, bekreftet støyfritt i den nye UTF8-testkjøringen.

**Testdekning:** `coding-agent-eval.test.ts` utvidet fra 35 til 68 tester (nye blokker D2-D5, I, J, K +
oppdatert D/H); ny `live-eval-utf8-persistence.test.ts` (6 tester). Full workspace-suite 124/124 filer,
1970/1970 tester grønt (opp fra 123/1931 - eksakt +1 fil/+39 tester), `pnpm -w typecheck` 18/18 rent,
`pnpm -w lint` rent. Én isolert `q18-read-dedupe.test.ts`-hook-timeout under full parallell suite bevist
urelatert (2/2 tester grønt kjørt alene) - embedded-Postgres ressurskonkurranse, ikke forårsaket av
denne sliceen. `TOTAL_REAL_PROVIDER_CALLS_FROM_FIRST_RUN=3` BEVART - INGEN nytt ekte provider-kall i
denne reparasjonen.

**D-64/D-41:** ingen ny leverandør, ingen ny risikoklasse, ingen kapabilitet svekket. **Sannhet ETTER
denne reparasjonen:** `LIVE_AGENT_INVOCATION_VERIFIED=true` (BEVART fra ekte bevis, aldri nedgradert),
`LIVE_DIAGNOSTIC_QUALITY_VERIFIED=false`, `LIVE_FIX_QUALITY_VERIFIED=false` (uavklart til korrigert
harness faktisk kjøres på nytt live). UA-5 kriterium 2=PARTIAL (uendret). `UA5_IMPLEMENTATION_COMPLETE=
false`, `UA5_CAN_CLOSE=false`. Draft-PR, IKKE merget. Neste ekte live-forsøk skjer FØRST etter at denne
reparasjonen er merget OG post-merge-CI på `main` er bekreftet grønn - Task A/B/C MÅ kjøres på nytt fra
FERSKE fixtures. Full detalj: D-100 i DECISIONS_AND_ASSUMPTIONS.md.

---

#### REAL CODING AGENT LIVE QUALITY VERIFICATION + HONEST-NOOP EVAL REPAIR (2026-08-21) → D-101 (EVIDENSKANONISERING + SMAL reparasjon, IKKE ny kapabilitet)

En ANDRE, KORRIGERT ekte Windows-live-kjøring (D-100s reparerte harness) fullførte VELLYKKET og
produserte det FØRSTE genuint gyldige kvalitetsbeviset: `PROVIDER_CALLS_COUNT=3`,
`LIVE_AGENT_INVOCATION_VERIFIED=true`, `LIVE_DIAGNOSTIC_QUALITY_VERIFIED=true`,
`LIVE_FIX_QUALITY_VERIFIED=true`. Task A/B nådde begge `verified_fix=true`; Task C nådde
`verified_fix=false` med `oracle_tampering=false`/`unauthorized_changes=false` - PASS mot den FROSNE
D-98/D-100-terskelen (uendret, verken FØR eller UNDER kjøringen). `QUALITY_THRESHOLD_MET=true` for alle
3 fixtures.

**HARNESS-SEMANTIKK-funn (ALDRI et modellkvalitetsfunn):** Task C sitt resultat inneholdt likevel
`harness_persistence_success=false`/`failure_category=HARNESS_PERSISTENCE_FAILURE`/
`error_class=commit_failed` - IKKE fikk lov til å nedgradere noen av de tre `LIVE_*_VERIFIED`-flaggene
(alle bevart `true`). **Rotårsak sporet i `coding.ts` (produksjonskode):** `createCodingHandler` kjørte
FØR denne reparasjonen UBETINGET `git add -A`+`git commit` uansett om agenten hadde gjort noen endring -
for Task C (der en korrekt agent bevisst avstår fra å gjette) staget `git add -A` ingenting, og
`git commit` feilet strukturelt med "nothing to commit" (STDOUT, ikke stderr), fanget av `must("commit",
...)` som en tom `commit_failed: `-feil. **Sekundær, tidligere ufunnet klassifiseringsbug oppdaget
samtidig:** `must(label, result)` kaster ALLTID `"${label}_failed: ..."`, men `KNOWN_ERROR_CLASSES`/
`PRE_AGENT_SUCCESS_LABELS` i `coding-agent-eval.ts` hadde kun de usuffikserte etikettene (`"clone"` osv.)
- de matchet derfor ALDRI en ekte kjøretids-`error_class`, og ALLE seks `must()`-baserte feilklasser ble
feilaktig klassifisert som `HARNESS_PERSISTENCE_FAILURE` ved eliminasjon (D-100s egne tester testet
uheldigvis de samme usuffikserte, aldri-forekommende strengene).

**Fikset (minimal, presis):** ny eksportert `coding.ts`-konstant `NO_CHANGES_TO_COMMIT_LABEL=
"no_changes_to_commit"` kastes nå (via `git status --porcelain` sjekket FØR add/commit) i stedet for en
tvunget tom commit - ingen empty commit, ingen meningsløs branch-push, ingen fabrikkert patch.
`classifyFailureCategory` behandler etiketten eksplisitt som `null` (identisk med "ingen feil" - et
strukturelt KORREKT utfall). `KNOWN_ERROR_CLASSES`/`PRE_AGENT_SUCCESS_LABELS` rettet til de faktiske
suffikserte strengene. **§9-invariant bevart:** jobben forblir FORTSATT markert "failed" (aldri
"completed") naar agenten ikke gjør noen endring - kun HVILKEN feil som rapporteres er endret, aldri om
jobben lykkes (bevist av en dedikert regresjonstest som viser `ScriptedCodingAgent`-banen er 100%
uendret).

**Q-26:** kvalitetspromoteringen er gyldig fordi terskelen ble frosset FØR resultatet ble sett OG BEGGE
Task A/B (ekte provider-kall + faktisk patch + uavhengig testport + ingen manipulasjon) og Task C (ekte
provider-kall + ingen fabrikkert `verified_fix` + skjult orakel utilgjengelig for agenten + ingen
manipulasjon) faktisk oppfylte den. `Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false` forblir GLOBALT
uendret. **UA-5 kriterium 2 vurdert på nytt, IKKE automatisk hevet:** agent-invokering OG modellkvalitet
er nå begge ekte live-verifisert, men fersk repo-sannhet bekrefter UENDRET
`PRODUCTION_CODING_HANDLER_WIRED=false`/`PRODUCTION_CODING_AGENT_WIRED=false`/
`TESTED_FIX_PIPELINE_PRODUCTION_REACHABLE=false` - kriterium 2 forblir `PARTIAL`, MEN gjenstående gap nå
presist avgrenset til produksjons-tilkobling/wiring, ALDRI lenger modellkvalitet. Kriterium 1/3/4
uendret fra D-100.

**Testdekning:** `coding-agent-eval.test.ts` utvidet fra 68 til 74 tester (D2/D3/D4-rettelser +
regresjonsbevis for de gamle usuffikserte strengene, ny blokk L: Task C sin ekte andre live-kjøring
modellert ende-til-ende + en verified_fix-fixture med samme etikett beviser fortsatt en ekte
modellsvikt). `fase6-worker.test.ts` +2 tester (ekte embedded-Postgres + ekte git-bare-repo): en
`NoOpCodingAgent` beviser jobben feiler med NØYAKTIG `NO_CHANGES_TO_COMMIT_LABEL` (aldri `commit_failed`),
ingen branch pushet, ingen commit, kun `test-log` persistert; `ScriptedCodingAgent`-banen bekreftet 100%
uendret. Full suite 124/124 filer, 1978/1978 tester grønt (opp fra 124/1970), `pnpm -w typecheck` 18/18
rent, `pnpm -w lint` rent. Alle D-96/D-97/D-98/D-99/D-100-relaterte regresjonssuiter eksplisitt re-kjørt
grønt uendret.

**D-64/D-41:** ingen ny leverandør, ingen ny risikoklasse, ingen produksjonskobling (rører KUN `coding.ts`s
interne add/commit-mekanikk, aldri callere/wiring). `TOTAL_REAL_PROVIDER_CALLS_FROM_FIRST_RUN=3`
(den gyldige kjøringen) bevart - INGEN nytt ekte provider-kall i selve reparasjonsrunden.
`UA5_IMPLEMENTATION_COMPLETE=false`, `UA5_CAN_CLOSE=false`. Draft-PR, IKKE merget. Neste faktiske UA-5-
gap (produksjons-tilkobling av `createCodingHandler`/`ClaudeCodeAgent`) forblir eksplisitt IKKE startet i
denne runden, kun identifisert. Full detalj: D-101 i DECISIONS_AND_ASSUMPTIONS.md.

#### PRODUCTION REAL CODING AGENT / TESTED-FIX PIPELINE WIRING v1 (2026-08-21) → D-102 (produksjons-wiring, IKKE ny kapabilitet, IKKE live ende-til-ende-verifisert)

FØR denne sliceen (D-101, fersk repo-sannhet): `PRODUCTION_CODING_HANDLER_WIRED=false`,
`PRODUCTION_CODING_AGENT_WIRED=false`, `TESTED_FIX_PIPELINE_PRODUCTION_REACHABLE=false` -
`createCodingHandler` hadde INGEN produksjons-callere. **Wiret nå inn i den EKTE produksjonsworkeren**
(`apps/api/src/worker-main.ts`): `worker.register("coding", withSecretRedaction(createCodingHandler({...}),
[ANTHROPIC_API_KEY, JARVIS_GITHUB_TOKEN]))` på SAMME `InProcessWorker`-instans som
`"executive"`/`"knowledge-ingest-email"` - gjenbruker samme `sandbox: runner` (ProcessSandboxRunner er
produksjonsdefault; `DockerSandboxRunner` er eksplisitt opt-in og fortsatt IKKE fikset for `jobEnv` denne
sliceen - ikke-blokkerende siden default-sandboxen støtter `jobEnv`), samme `ArtifactStore(pool)`, og samme
`toolGateway`-instans for PR-publisering (arver D-97 rate-limiting).

**ABSOLUTT SIKKERHETSREGEL bevart:** `ScriptedCodingAgent` verken importeres eller instansieres i
`worker-main.ts`; produksjonen bruker den EKTE `ClaudeCodeAgent` (D-96/D-100/D-101). Mangler ekte
Claude-credential feiler jobben strukturelt lukket via `ClaudeCodeAgent`s EGEN konfigurasjonssjekk
(`claude_code_not_configured`) - ALDRI et stille fall til `ScriptedCodingAgent`, ALDRI fabrikkert
kode/patch/PR. `EnvSecretProvider` (eksisterende) gjenbrukt uendret for `ANTHROPIC_API_KEY` - INGEN nytt
credential-lager. `CLAUDE_BINARY_RESOLUTION_POLICY`: kun eksplisitt `JARVIS_CLAUDE_BIN` denne sliceen,
PATH-auto-oppløsning bevisst IKKE lagt til.

**Eierautoritet:** `identityFor` bruker jobbens EGEN `task.contract.owner_person_id`/`task.tenant_id`
(ALDRI en fast worker-identitet) - kodelest nødvendig fordi produksjonens `PolicyGateway` har INGEN
`mandates`, så klasse C (`create_pr`) auto-ALLOW skjer KUN via SOVEREIGN-identitetsmatch. D-94s
risikoklasser bekreftet uendret (`create_pr`=C, `merge_pr`=D) - INGEN `merge_pr`-kall denne sliceen (INGEN
auto-merge). `allowed_tools`-kontrakten (D-95) uendret og bevist ved en EKTE kjøretidstest.

**Minimal, gjenbrukt produksjonsinngang:** `TaskService.submit()` (eksisterte allerede, full validering,
men hadde null produksjons-callere) eksponert som `POST /tasks/submit` i `server.ts`, gjenbruker SAMME
`TaskService`-instans som `ConversationEngine`. **Nytt forsvar-i-dybden:** `withSecretRedaction()` (ny
funksjon i `coding.ts`) redigerer kjente hemmeligheter fra ethvert thrown-feilbudskap FØR `tasks.last_error`
- ikke en ny lagringsmekanisme. **Genuint pre-eksisterende hull lukket:** `modules/tasks/src/index.ts`
re-eksporterte aldri `pr-publisher.ts` siden D-95 - fikset rent additivt.

**Testdekning:** 22 nye tester i 3 nye filer - `coding-secret-redaction.test.ts` (6),
`worker-coding-wiring.test.ts` (11, kildemønster mot faktisk `worker-main.ts`),
`coding-production-wiring.test.ts` (5, EKTE ende-til-ende med ekte embedded-Postgres + ekte HTTP-server +
ekte git-bare-repo - Test A beviser `/tasks/submit`→queue→worker→`createCodingHandler`→EKTE
`ClaudeCodeAgent` er nåbar og feiler korrekt lukket uten credential; Test D beviser hele suksessveien via
DEN SAMME produksjonsfunksjonen med en lokal test-dobbel som eneste stedfortreder for det utilgjengelige
Anthropic-kallet). Full suite `TESTS_AFTER=2000`/`TEST_FILES_AFTER=127` (opp fra
`TESTS_BEFORE=1978`/`TEST_FILES_BEFORE=124`), typecheck 18/18 rent, lint rent, ingen regresjon.

**ÆRLIG LIVE-VERIFISERINGSSTATUS:** dette kjøremiljøet har verifisert INGEN `ANTHROPIC_API_KEY`, INGEN
`JARVIS_GITHUB_TOKEN` konfigurert - en ekte live ende-til-ende-kjøring var derfor IKKE mulig her.
`HOST_ACTION_REQUIRED=true` rapportert i stedet for fabrikkert bevis. **Konklusjon:**
`PRODUCTION_CODING_HANDLER_WIRED=true`, `PRODUCTION_CODING_AGENT_WIRED=true` (begge strukturelt OG
kjøretids-bevist), men `TESTED_FIX_PIPELINE_PRODUCTION_REACHABLE` forblir IKKE live-verifisert
ende-til-ende. **UA-5 kriterium 2 forblir `PARTIAL`** - gjenstående gap presist avgrenset til ekte
Anthropic-/GitHub-credential på Tobias sin vert pluss én eierautorisert live-aksept-kjøring. Kriterium
1/3/4 uendret. `UA5_IMPLEMENTATION_COMPLETE=false`, `UA5_CAN_CLOSE=false`. Draft-PR, IKKE merget. INGEN ny
leverandør, INGEN UA-6. Full detalj: D-102 i DECISIONS_AND_ASSUMPTIONS.md.

#### PRODUCTION CODING REACHABILITY REPAIR v1 (2026-08-21) → D-103 (to ekte produksjonsblokkere reparert, IKKE ny kapabilitet)

Oppdaget under D-102s egen host-akseptanse-forberedelse (fersk kildekode-revisjon): TO reelle,
uavhengige produksjons-nåbarhetsblokkere som ingen enkelt-prosess wiring-test kunne fange.

**Blokker A (worker claim-routing):** `main.ts` sin egen `InProcessWorker` (kun `"executive"`) og
`worker-main.ts` sin (har `"coding"`) polte SAMME `PgTaskQueue` samtidig - `claim_next_task()` var
agent-profil-blind, så `main.ts` kunne claime en coding-jobb og terminalt feile den med "ingen handler
for agentprofil coding". **Fikset:** ny migrasjon `035_worker_claim_profile_filter.sql` gir
`claim_next_task()` et tredje `p_agent_profiles text[]`-argument - filtreringen skjer ATOMISK i samme
`FOR UPDATE SKIP LOCKED`-transaksjon. En ustøttet jobb forblir `'created'` (aldri feilet) til en
kompatibel worker henter den, ingen starvation. `WorkflowAdapter.claimNext()`/`PgTaskQueue.claimNext()`
fikk `agentProfiles` som et påkrevd tredje argument; `InProcessWorker.tick()` sender automatisk
`[...this.handlers.keys()]`. Lease/reclaim/retry/tenant-isolasjon/FORCE RLS uendret.

**Blokker B (git-transport-autentisering):** `ProcessSandboxRunner` gir `git clone`/`git push` en ren
prosess-env (kun PATH + git-identitet + eksplisitt jobEnv) - ingen HOME/USERPROFILE/SSH_AUTH_SOCK, så
push mot en ekte GitHub-remote hadde ingen eksplisitt credential-kanal (ville avhengt av ambient,
aldri-bevist vertstilstand). **Fikset:** ny `modules/tasks/src/git-auth.ts` - et ephemert
`GIT_ASKPASS`-skript per jobb (filen inneholder aldri token-verdien, kun logikk som leser den fra sin
egen prosess-env ved kjøretid), skrevet i en egen temp-katalog (aldri i `sandbox.workdir`), fjernet i
`finally` uavhengig av `sandbox.dispose()`. `Sandbox.exec()` fikk en valgfri fjerde `extraEnv`-parameter
(kun `ProcessSandboxRunner` kobler den inn). `createCodingHandler` fikk et nytt valgfritt `gitAuth`-felt
(default `JARVIS_GITHUB_TOKEN`, samme `EnvSecretProvider`-arkitektur som `claudeCodeCredential` - helt
atskilt referanse) - `extraEnv` gis KUN til de to faktiske clone/push-kallene, aldri til `run`
(agent.modify + lokale git-operasjoner) - `ClaudeCodeAgent` ser derfor strukturelt aldri GitHub-tokenet.
Mangler secreten: `git_auth_unavailable` kastes FØR clone forsøkes - aldri et stille fall til
uautentisert git. Uten `gitAuth` i det hele tatt (default) er sandbox-oppførselen 100% uendret.

**Cancellation:** `ctx.assertNotCancelled()` lagt til FØR push og FØR PR-publisering - de to nye,
produksjons-nåbare eksterne grensene. Gjenstående gap (test-bestått→commit, commit→push) uendret fra
D-95/D-96, klassifisert NON_BLOCKING_FOLLOWUP.

**Testdekning:** `worker-claim-routing.test.ts` (12, ekte embedded-Postgres, inkl. et RLS-fallgruve-funn
identisk D-92-klassen). `git-auth.test.ts` (10, ren logikk). `coding-git-auth-wiring.test.ts` (10, ekte
embedded-Postgres + ekte lokalt git-bare-repo - beviser extraEnv-isolasjon, ingen token i argv/config/
feilmeldinger, fail-closed, ephemer opprydding, D-95 PR-flyt upåvirket). `worker-coding-wiring.test.ts`
+2. Full suite `TESTS_AFTER=2034`/`TEST_FILES_AFTER=130` (opp fra `TESTS_BEFORE=2000`/
`TEST_FILES_BEFORE=127`), typecheck 18/18 rent, lint rent, ingen regresjon i D-95/D-96/D-97/D-100/D-101/
D-102-suiter.

**Ærlig status:** ingen ekte Anthropic/GitHub-credential i dette miljøet - `LIVE_E2E_VERIFIED=false`,
`TESTED_FIX_PIPELINE_PRODUCTION_REACHABLE=false`, `HOST_ACTION_REQUIRED=true` forblir uendret; denne
sliceen reparerer reachability-forutsetninger, hevder IKKE live-verifisering. UA-5 kriterium 2 forblir
bevisst `PARTIAL`. Kriterium 1/3/4 uendret. `UA5_IMPLEMENTATION_COMPLETE=false`, `UA5_CAN_CLOSE=false`.
Draft-PR, IKKE merget. Revidert, hemmelighet-trygg host-akseptanse-runbook levert, IKKE utført denne
sliceen. Full detalj: D-103 i DECISIONS_AND_ASSUMPTIONS.md.

#### D-103 HOST-FIX (2026-08-21) → "d103-host-git-auth-isolation-repair" (amendment til D-103, ikke ny D-nummer)

Tobias sin FØRSTE ekte Windows host-akseptanse beviste Blokker A live (riktig worker claimet jobben),
og den ekte kodeagenten nådde helt frem til `git push` - men autentiserte som en ambient, feil identitet
(`post-ops`) i stedet for det verifiserte `JARVIS_GITHUB_TOKEN`. Root cause: git sin credential-subsystem
spør ALLTID `credential.helper`-kjeder FØR `GIT_ASKPASS` konsulteres - askpass er en ren prompt-fallback,
ALDRI en prioritert credential-kilde. TO fiks: (1) `-c credential.helper=` (git sin egen "nullstill
helper-kjeden for dette kallet"-mekanisme, `GIT_CREDENTIAL_ISOLATION_ARGS`) prependet KUN til clone/push-
argv. (2) en LATENT bug i selve D-103s opprinnelige `GIT_ASKPASS`-format (`"<node>" "<skript>"`) - viste
seg EMPIRISK å ikke bli kommandolinje-parset av git på POSIX (aldri fanget FØR, siden alle D-103-tester
brukte lokale bare-repo-kloner som aldri trigger credential-oppløsning) - fikset med en plattform-betinget
`buildAskpassEnvValue()` (bar sti på POSIX, `.cmd`-wrapper på Windows).

**Testdekning:** `git-credential-isolation.test.ts` (5, ny - en EKTE selvhostet git smart-HTTP-server via
`git http-backend`, kjørt i en egen barneprosess - beviser med en ekte ambient credential.helper at fiksen
faktisk hindrer identitetskapring, både for clone og push). `git-auth.test.ts` +6, `coding-git-auth-
wiring.test.ts` +3 (inkl. cleanup-på-fortvunget-feil, tidligere flagget testdekning-gap). Full suite
`TESTS_AFTER=2048`/`TEST_FILES_AFTER=131`, typecheck/lint rent, ingen regresjon.

**Ærlig status:** INGEN system/global git-config mutert, INGEN credential-store rørt. `WORKER_PROFILE_
ROUTING_LIVE_VERIFIED=true`/`REAL_CODING_JOB_REACHED_GIT_PUSH=true` (ekte, fra host-kjøringen) - men
`LIVE_E2E_VERIFIED=false`/`TESTED_FIX_PIPELINE_PRODUCTION_REACHABLE=false`/`HOST_ACTION_REQUIRED=true`/
`UA5_CRITERION_2=PARTIAL` uendret inntil Tobias kjører runboken på nytt. Ny draft-PR, IKKE merget.

#### D-103 HOST-FIX v2 (2026-08-21) → "d103-git-credential-helper-windows-repair" (amendment til D-103, ikke ny D-nummer)

En ANNEN ekte Windows-kjøring, ETTER v1 var merget til main, beviste at v1s isolasjonsfiks FAKTISK
virket LIVE (ingen `post-ops`-identitet dukket opp lenger), men selve v1s `GIT_ASKPASS`-mekanisme feilet
på et NYTT sted: `cannot spawn "...\jarvis-git-askpass-<x>\askpass.cmd": Permission denied`. Root cause
(utledet, ikke live-bevist mot ekte Windows): git kaller `GIT_ASKPASS` med `use_shell=1`, men hopper over
selve shell-innpakningen for en bar sti uten shell-metategn - git kaller da `CreateProcessW()` DIREKTE på
`.cmd`-stien, som IKKE er et gyldig Win32 PE-avbilde og derfor strukturelt ikke kan lastes direkte
(`ERROR_ACCESS_DENIED` → MSYS-oversatt til "Permission denied").

**Fiks:** GIT_ASKPASS erstattet HELT med git sin `credential.helper`-mekanisme, satt via en ny
`-c credential.helper=!"<node>" "<skript>"` (etter den uendrede `GIT_CREDENTIAL_ISOLATION_ARGS`-reset-en).
`!`-prefikset tvinger git til å evaluere verdien via en EKTE shell (`sh -c`, MSYS sin `sh.exe` på Windows)
som launcher `node.exe` (ekte, allerede installert PE-binær) med skriptet som argument - ALDRI en direkte
`CreateProcess()` av vår genererte fil. Eliminerer feilklassen STRUKTURELT på begge plattformer, IDENTISK
form (ingen plattform-gren lenger nødvendig). `DockerSandboxRunner.exec(extraEnv)`-gap (tidligere flagget,
ikke koblet inn i `docker run`) reparert i samme slice via bar `-e <NAVN>`-argv + CLI-subprosess-env.

**Testdekning:** `sandbox-docker-extra-env.test.ts` (5, ny). `git-auth.test.ts` (15, omskrevet for
credential-helper-protokollen). `git-credential-isolation.test.ts` (7, omskrevet - C/D beviser nå at git
FAKTISK invokerer mekanismen mot en ekte HTTP-credential-utfordring; nye F/G beviser fail-closed
eksplisitt). `coding-git-auth-wiring.test.ts` (13, omskrevet argv-form). Full suite
`TESTS_AFTER=2056`/`TEST_FILES_AFTER=132` (korrigert 2026-08-21: `2054` var korrekt for den FØRSTE v2-commiten, men to påfølgende `windows-git-auth`-CI-fiks-commits la til `git-auth.test.ts` sine L2/L3-tester - `2056` er det faktiske, verifiserte tallet på PR #46s merget HEAD `ad96d33`), typecheck/lint rent, ingen regresjon. Ny, fokusert
`windows-git-auth`-CI-jobb (`windows-latest`, kun de to Postgres-frie testfilene) lagt til
`.github/workflows/ci.yml` - direkte mot klassen "korrekt på Linux, feiler på ekte Windows".

**Ærlig status:** INGEN system/global git-config mutert, INGEN credential-store rørt.
`WORKER_PROFILE_ROUTING_LIVE_VERIFIED=true`/`REAL_CODING_JOB_REACHED_GIT_PUSH=true`/
`AMBIENT_CREDENTIAL_HELPER_CAN_OVERRIDE_JARVIS_AUTH=false` (alle ekte, fra host-kjøringene) - men
`WINDOWS_LIVE_AUTH_ISOLATION_VERIFIED=false`/`LIVE_E2E_VERIFIED=false`/
`TESTED_FIX_PIPELINE_PRODUCTION_REACHABLE=false`/`HOST_ACTION_REQUIRED=true`/`UA5_CRITERION_2=PARTIAL`
uendret inntil Tobias kjører runboken på nytt. Ny draft-PR, IKKE merget. Full detalj: D-103 HOST-FIX v2 i
DECISIONS_AND_ASSUMPTIONS.md.

### D-104: UA-5 Production Operations Control Plane v1 (2026-08-21)

Bygget i samme gren/PR som D-103-run-3-kanoniseringen over (UA-5 kriterium 2 er nå `COMPLETE`). Ny
`@jarvis/incidents`-pakke (JARVIS_CANONICAL, D-64-porten kjørt FØRST - GCP/Cloudflare/Sentry/Vercel-deploy/
log-spørring eksisterer IKKE i repoet, INGEN av dem bygges her): deterministisk `IncidentService`
(lifecycle + bevis som ALDRI overskrives, kun lagt til med eksplisitt `contradicts_evidence_id`),
`DeploymentService`/`correlateIncident()` (deterministisk tidsvindu-korrelasjon, Q-26-stil
`UNVERIFIED`/`PROVISIONAL`/`VERIFIED`), `proposeRepairTask()` (gjenbruker `TaskService.submit()`/
`createCodingHandler` 100% uendret - bygger KUN orkestrering rundt den EKSISTERENDE, D-102/D-103-live-
bevist testet-fiks-pipelinen), `attemptRecovery()` (before/after via den EKSISTERENDE `tool_executions`-
D-pipelinen, selve recovery-forsøket UTELUKKENDE via `ToolGateway.execute()` - ÉN representativ, EKTE
case: `github.delete_branch`→`create_branch`). Ny `InfraExecutionGate` (`modules/policy`,
NORMAL/DEGRADED/PAUSED) - en NY, SNEVRERE bryter enn `KillSwitch` (uendret, forblir strengest), koblet
inn som et valgfritt felt i `PolicyGatewayOptions` (bakoverkompatibelt uten konfig). Ny migrasjon
`036_incidents.sql` (RLS/GRANT-mønster identisk `024_support.sql`), erasure-plan-registrering for
`incidents`/`incident_evidence`. 42 nye tester i 5 nye filer mot EKTE embedded-Postgres/EKTE lokalt
git-bare-repo/EKTE `ToolGateway`. Full suite `TESTS_AFTER=2098`/`TEST_FILES_AFTER=137` (opp fra
`2056`/`132`), typecheck/lint rent. **UA-5 kriterium 1/3 forblir `PARTIAL`** (deterministisk fixture-/
integrasjonsbevis, INGEN ekte GitHub-webhook/provider-rollback utøvd) - **kriterium 4 er `COMPLETE`**
(gaten fullt koblet inn og test-bevist mot ekte `PolicyGateway`-runtime i begge produksjonsprosesser, én
dokumentert prosess-lokalitetsbegrensning, samme klasse som eksisterende `KillSwitch`). `UA5_
IMPLEMENTATION_COMPLETE=false`, `UA5_CAN_CLOSE=false`. Ny draft-PR, IKKE merget. Full detalj: D-104 i
DECISIONS_AND_ASSUMPTIONS.md.

### D-105: UA-5 Production Operations Control Plane v2 (2026-08-22)

Lukker D-104s kjente kriterium 1/3-hull. D-64-porten kjørt FØRST (repo-audit): ingen Docker-container-
styring/Vercel-mutasjon/GCP/Cloudflare eksisterte fra før. Docker Engine valgt som DEN ENE sammenhengende
overflaten for BÅDE observability OG kritisk infra-mutasjon (`SOR_CLASSIFICATION=HYBRID_WITH_CLEAR_
AUTHORITY`, `CORE_DEPENDENCY_DECISION_REQUIRED=false` - Jarvis forblir kanonisk for hendelse/diagnose/
eksekusjonsjournal/policy/recovery-orkestrering). Ny `docker`-transport (`modules/tool-gateway/src/
docker-transport.ts`): lese-handlinger (`list_containers`/`inspect_container`/`get_logs`, klasse A) virker
mot ETHVERT containernavn; `redeploy_container` (klasse D, `preflight_action: "inspect_container"` -
gjenbruker den EKSISTERENDE D-104 tool_executions-D-pipelinen) NEKTES STRUKTURELT mot alt utenfor
`jarvis-sentinel-*` (forsvar-i-dybden, uavhengig av policy). `acquireContainerLogs()` (redigert to ganger
FØR persistering, hard `tail`-grense) og `correlateDbState()` (bruker den EKSISTERENDE `schema_migrations`-
tabellen, INGEN ny leverandør, bevist mot en EKTE uoppnåelig database også). Ny diagnose-modell
(`incident_diagnoses`/`incident_diagnosis_evidence`, migrasjon `037_infra_ops_v2.sql`) - ATSKILT fra rå
evidens; en revurdering oppretter en NY rad (`supersedes_diagnosis_id`), den gamle forblir UENDRET/
spørrbar. Ny APPEND-ONLY `infra_executions`-eksekusjonsjournal (VED SIDEN AV den 100% uendrede
`tool_executions`) med deterministisk grunn-diff (`computeStateDiff()`, `diff.ts` - ALDRI LLM-sammenligning)
og eksplisitt firetilstands-utfall (SUCCESS/PARTIAL/FAILED/UNKNOWN - `PARTIAL` når et kall lykkes teknisk
men lander feil). `docker:redeploy_container` lagt til den eksisterende `RECOVERY_STRATEGIES` (`recovery.ts`)
- REQUERIER tilstanden etter gjenoppretting for faktisk verifisering, ikke bare "kallet returnerte ok".
`InfraExecutionGate.infraToolIds` utvidet fra `{"github"}` til `{"github","docker"}` i BEGGE
produksjonsprosesser - samme gate/semantikk, bevist for docker inkl. KillSwitch-supremati. 47 nye tester i
6 nye filer (`docker-transport.test.ts` mot en FAKE `docker`-CLI på disk, ALDRI en ekte daemon i CI - samme
presedens som D-103s `sandbox-docker-extra-env.test.ts`). Full suite `TESTS_AFTER=2145`/`TEST_FILES_AFTER=143`
(opp fra `2098`/`137`), typecheck/lint rent. **UA-5 kriterium 1/3 forblir `PARTIAL`** - nå strukturelt
komplette ende-til-ende, men INGEN ekte Docker-daemon i dette kjøremiljøet (`docker ps` feiler mot Unix-
socketen her) - `LIVE_VERIFIED=false` for alle nye flagg, ny runbook `docs/runbooks/
D105_INFRA_OPS_V2_HOST_ACCEPTANCE.md` levert for at Tobias selv kan bevise dette mot en ekte, disponibel
daemon UTEN å røre produksjonscontainere. `UA5_IMPLEMENTATION_COMPLETE=false`, `UA5_CAN_CLOSE=false`. Ny
draft-PR, IKKE merget. Full detalj: D-105 i DECISIONS_AND_ASSUMPTIONS.md.

### D-106: AI Mesh Council/Collaboration/lokal-Gemma-utvidelse (2026-08-22)

Første kapabilitetsslice etter UA-5 canonical closeout, IKKE UA-6. "FØR DU KODER"-audit kjørt FØRST: D-79/
D-80/D-81 ("AI Mesh Gemma-first") var ALLEREDE en moden, FIXED_SUITE_VERIFIED arkitektur (`AiRouter`/
`CapabilityRegistry`/`ProviderHealthTracker`/budsjett/kost/trace/tool-loop-idempotens/critic-mønster) -
`EXISTING_AI_MESH_AUDITED=true`, `D80_REUSED=true`, `CORE_DEPENDENCY_DECISION_REQUIRED=false`. Denne
sliceen UTVIDER, bygger IKKE en parallell AI Mesh. Genuint nytt: (1) `gemma_local` - Gemma kjørt LOKALT
(RTX 4070-PC eller annen vertsmaskin) via SAMME `LocalOpenAiCompatibleAdapter` som `local_llm` (nå
navn-konstruktør-injiserbar), distinkt fra hostet `gemma_hosted` (D-80). (2) `paid_models_allowed`-policy
(`router.ts`/`CompleteInput`) - `false` begrenser til `locality=local`, fail-closed
(`PaidModelsDisabledError`), gjelder også eksplisitt eier-override. (3) `providerPreference` (ordnet
preferanseliste, f.eks. "bruk Gemma" -> `[gemma_local,gemma_hosted]`). (4) `override-parser.ts` - 100%
deterministisk fraseparsing (ALDRI en LLM som tolker instruksjonen) for eksplisitte routing-fraser ("bruk
bare Claude/OpenAI/Gemini/Kimi/Gemma", "bruk alle AI-ene", "ikke bruk betalte modeller", "bruk bare lokale
modeller", "velg den beste modellen"), komponert inn i `ConversationEngine.handle()`. (5) `AiCouncil`
(`council.ts`) - 3-runders protokoll (uavhengig runde 1 = anti-anchoring bevist strukturelt, kryss-kritikk
runde 2, revisjon runde 3), ETT eksplisitt synteseanrop, `consensus_status` beregnet DETERMINISTISK i kode
(aldri en selvrapportert modell-enum), degradert Council eksplisitt håndtert (`unavailable_members`/
`full_council`), `requireAllFive` fail-closed (`IncompleteCouncilError`). (6) `AiCollaboration`
(`collaboration.ts`) - deterministisk rolletildeling (kode, ikke LLM) -> parallelt arbeid -> kryssgjennomgang
(aldri selvgjennomgang) -> syntese, opt-in revisjon/verifikasjon. Begge persisterer til de EKSISTERENDE
`events`(`EventWriter`)/`artifacts`-tabellene - INGEN ny tabell. 65 nye tester i 6 nye filer (router/
paid-models/providerPreference, override-parser, council, collaboration, ConversationEngine-wiring, mot
fake `ModelGateway`-providere - ingen ekte nettverk). Full suite `TESTS_AFTER=2261`/`TEST_FILES_AFTER=150`
(opp fra `≈2196`/`144`), typecheck/lint rent, én kjent embedded-Postgres parallell-CI-hook-timeout i en
UBERØRT fil bevist som flake ved isolert kjøring (2/2 grønt alene). **Live-status:** OpenAI/Anthropic
uendret; Gemini/Kimi/gemma_hosted `UNCONFIGURED` i dette miljøet (uendret fra D-80); `gemma_local`
`HOST_RUNTIME_REQUIRED` - ny runbook `docs/runbooks/D106_LOCAL_GEMMA_HOST_ACCEPTANCE.md` levert for at
Tobias selv kan verifisere mot RTX 4070-PC-en. Eksplisitt DEFERRED (v1, korrigert av HOST-FIX under):
automatisk høy-innvirkning-beslutning-klassifisering for Council (kun eksplisitt bruker-trigger bygget),
tekst-override persisterer kun for gjeldende samtaletur (ikke sesjonsskopet), `AiCollaboration` ikke
automatisk TaskEngine-trigger-klassifisert. Ny draft-PR, IKKE merget. INGEN UA-6. Full detalj: D-106 i
DECISIONS_AND_ASSUMPTIONS.md.

**D-106 HOST-FIX (2026-08-22, automatisk høy-innvirkning-beslutning-klassifisering for Council, samme PR
#51, AMENDMENT ikke ny D-nummer):** Tobias avviste v1-closeoutet - den godkjente spesifikasjonen krevde BÅDE
eksplisitt bruker-trigger OG automatisk høy-innvirkning-klassifisering for Council, kun den første var
bygget. Reparert med ny, 100% deterministisk klassifiserer (`decision-importance.ts`,
`classifyDecisionImportance()` - INGEN modellkall, regex-mønstre over åtte harde + tre svake kategorier,
versjonert `CLASSIFIER_VERSION`), som klassifiserer `ROUTINE`/`SIGNIFICANT`/`HIGH_IMPACT_DECISION`.
Risikoklasse (A-D, `ToolGateway.capability_class`) og beslutnings-viktighet er BEVISST distinkte dimensjoner
- klassifiseringsmodulen har INGEN referanse til `capability_class`, klasse-D alene trigger IKKE Council
(bevist eksplisitt av test). Trigger-presedens i `ConversationEngine.handle()`: eksplisitt undertrykkelse
("ikke bruk AI-rådet"/"don't use the council", ny `suppressCouncil`-gren i `override-parser.ts`, sjekket
FØR triggerfrasen) vinner ALLTID - eierens autoritet begrenses ALDRI stille; deretter eksplisitt trigger
(`trigger_source="explicit_user"`); deretter automatisk klassifiserer-resultat `HIGH_IMPACT_DECISION`
(`trigger_source="high_impact_classifier"`) - IKKE stille undertrykt av en samtidig tvunget
enkelt-provider-override. Gjenbruker DEN EKSISTERENDE Council-implementasjonen UENDRET (ingen ny
Council-vei) - nytt valgfritt `CouncilInput.trigger`/`CouncilResult.provenance.trigger`-felt tredd gjennom
SAMME eksisterende `events`/`artifacts`-persistens, full auditerbarhet. 34 nye tester (20
`decision-importance.test.ts` - alle seks HIGH_IMPACT-eksempler fra ordren + ni ROUTINE-negativer + fem
determinisme-/auditerbarhetstester; +3 `override-parser.test.ts`; +11 `conversation-d106-overrides.test.ts`
- tenant-isolasjon, `paid_models_allowed`-interaksjon, degradert Council aldri falsk `full_council=true`,
eksisterende overrides/Gemma-first-ruting uendret). Full suite `TEST_FILES_AFTER=151`/`TESTS_AFTER=2295`
(opp fra `150`/`2261`), typecheck 19/19 rent, lint rent, INGEN regresjon. Gjenværende DEFERRED
(ikke-blokkerende): tekst-override-persistens på tvers av samtaleturer (krever sesjonsskopet
preferanselager), `AiCollaboration` automatisk TaskEngine-trigger (distinkt verktøy, ordren krevde
spesifikt Council-auto-trigger). `Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false` uendret. Samme PR #51, ikke ny
PR, IKKE merget. INGEN UA-6. Full detalj: D-106 HOST-FIX i DECISIONS_AND_ASSUMPTIONS.md.

**D-106 HOST-FIX 2 (2026-08-22, Council Gemma-familie-mismatch, EGEN reparasjons-PR fra `main` - PR #51 er
allerede merget - AMENDMENT ikke ny D-nummer):** etter at Tobias fikk sin lokale Gemma-runtime live (RTX
4070, Ollama, `gemma3:4b`), identifiserte han at `AiCouncil` hardkodet `gemma_hosted` som Gemma-familiens
Council-medlem (`DEFAULT_COUNCIL_MEMBERS`), mens den faktiske kanoniske lokale runtimen er `gemma_local` -
et strukturelt mismatch. Reparert: `DEFAULT_COUNCIL_MEMBERS` erstattet med `CANONICAL_COUNCIL_FAMILIES`
(`"gemma"` er nå en FAMILIE-label, ikke en provider-identitet) + ny privat
`AiCouncil.resolveGemmaFamilyProvider(paid_models_allowed?, sensitivity?)` som løser familiens KONKRETE
Council-medlem DYNAMISK per kjøring, 100% deterministisk Jarvis-kode (§35): `gemma_local` FORETRUKKET når
konfigurert OG helsetilstand ikke `UNAVAILABLE` (samme regel `AiRouter` bruker for Gemma-first-ruting) ->
ellers `gemma_hosted` SOM FALLBACK - KUN når konfigurert, helse ikke `UNAVAILABLE`,
`paid_models_allowed!==false`, OG `sensitivity==="PUBLIC_OR_LOW_SENSITIVITY"` (D-81s eksisterende
`isSensitivityEligible()`-regel gjenbrukt UENDRET, nå eksportert fra `router.ts` - ALDRI duplisert) ->
ellers Gemma-familien er `unavailable`, seedet EKSPLISITT inn i `unavailable_members` FØR runde 1 i det
hele tatt forsøkes, slik at `full_council` korrekt blir `false` i stedet for den tidligere falske `true`
for en aldri-forsøkt familie. Gemma telles ALDRI som to medlemmer - `members`-listen inneholder ENTEN
`gemma_local` ELLER `gemma_hosted`, aldri begge. Ny `CouncilResult.provenance.gemma_family_provider`-felt
registrerer AUDITERBART hvilken konkret provider som faktisk representerte familien. Dynamisk oppløsning
gjelder KUN default-veien (`ConversationEngine` sender ALDRI `members` eksplisitt - urørt av denne
reparasjonen, BÅDE eksplisitt bruker-trigger OG automatisk høy-innvirkning-trigger går uendret til SAMME
Council). Eksplisitt `members`-kall (alle 12 opprinnelige D-106-tester) 100% uendret, ingen
familie-spesialhåndtering. **Testdekning (9 nye tester, `council.test.ts` M-T):** gemma_local
foretrukket+frisk; helse-basert fallback til gemma_hosted når sensitivitet kvalifisert; udefinert
sensitivitet -> gemma_hosted IKKE brukt (D-81-fail-safe respektert for Council også); `paid_models_allowed=
false` blokkerer betalt fallback selv med sensitivitet kvalifisert; verken backend konfigurert -> familie
unavailable, de fire andre familiene uendret; `requireAllFive=true` + familie unresolved ->
`IncompleteCouncilError` fail-closed; familien telles nøyaktig én gang selv når begge backends er friske
samtidig; rundeprotokollen (uavhengig runde 1/kryss-kritikk/revisjon/syntese) 100% uendret i default-veien;
eksplisitt `members` fortsatt bakoverkompatibel. Alle 12 opprinnelige tester uendret grønne. `pnpm -w
typecheck` 19/19 rent, `pnpm -w lint` rent. **Ærlig gjenværende nyanse:** `gemma_hosted`-fallback krever
eksplisitt `sensitivity` satt til `PUBLIC_OR_LOW_SENSITIVITY` i Council-kallet - `ConversationEngine` setter
i dag ALDRI dette eksplisitt, så i PRAKSIS vil gemma_hosted-fallback sjelden faktisk kvalifisere via denne
veien per nå. Dette er D-81s BEVISSTE fail-safe-holdning som fortsatt håndheves korrekt (udefinert
sensitivitet skal ALDRI stille kvalifisere en delt gratis-tier-leverandør), IKKE en ny begrensning innført
av denne reparasjonen - en fremtidig utvidelse av `ConversationEngine` til å sette `sensitivity` eksplisitt
for Council-kall er en mulig, IKKE-blokkerende fremtidig forbedring. `Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=
false` uendret. Egen, fokusert reparasjons-PR fra `main`, IKKE PR #51 (allerede merget) - INGEN uvedkommende
endringer blandet inn. PR opprettes som draft, IKKE merget. INGEN UA-6. Full detalj: D-106 HOST-FIX 2 i
DECISIONS_AND_ASSUMPTIONS.md.

**D-106 HOST-FIX 3 (2026-08-23, produksjonsherding etter FØRSTE ekte host-live-akseptanse, fem defekter
A/C/D/B/E, AMENDMENT ikke ny D-nummer):** Tobias sin FØRSTE ekte host-live-akseptansekjøring (etter PR #52)
avdekket fem produksjonskode-defekter, ikke bare dokument-/diagnostikkgap som de to foregående rundene.
**A (Gemma URL dobbel `/v1`):** `LocalOpenAiCompatibleAdapter` fikk en live-bevist `/v1/v1` (runbok
instruerte `/v1`-suffiks, adapteren appenderte selv `/v1/chat/completions`) - ny eksportert
`normalizeLocalLlmBaseUrl()` (`local-llm.ts`) strips EN eksakt avsluttende `/v1` (aldri delvis
match/urelatert mangling), adapteren bygger stien nøyaktig én gang uansett hvilken av de 4 dokumenterte
URL-formene operatøren setter. `.env.example`/runbok oppdatert til root-formen som kanonisk.
**C (Gemma-first ikke garantert):** live-bevist eksakt 132=132-scoringsuavgjort mellom `gemma_local`/`openai`
for et ordinært CHAT-purpose, avgjort av registrerings-REKKEFØLGE (stabil sort), ikke policy - ny
`AUTO_LOCAL_TIE_BREAK_BONUS=0.5` (`router.ts`, bevisst mindre enn minste mulige heltalls-scoringsdifferanse
- kan ALDRI overstyre en reell kvalitets-/kost-forskjell, KUN et eksakt uavgjort), ny `RoutingReason`
`LOCAL_PREFERRED_ON_TIE`, provider-nøytral (locality-drevet, IKKE et navnesjekk), registrerings-rekkefølge-
uavhengighet eksplisitt bevist med motsatt Map-konstruksjonsrekkefølge. **D (Council ugyldig JSON):**
live-bevist `invalid_json_shape`/`council_synthesis_invalid` mot ekte modellsvar - `extractJson()`
(`council.ts`, delt med `collaboration.ts`) helt omskrevet til en streng, deterministisk uthenter: markdown-
fences strippes (én fence = bruk KUN den, aldri fallback ved feil; flere fences = tvetydig, feiler ærlig),
ellers streng-bevisst balansert-brace-skanning som krever PRESIST én gyldig kandidat (null ELLER flere
gyldige kandidater feiler BEGGE ærlig). Skjemavalidering hos kalleren uendret. Provider-native
structured-output-modus vurdert, bevisst UTELATT (ikke alle fem familier hevder capability-en, ville tvunget
en enkelt-leverandør-avhengighet - ordren forbød dette eksplisitt). **B (Gemini/Kimi 404):** rot-årsak
undersøkt mot gjeldende offisiell dokumentasjon - INGEN bevist avvik funnet i eksisterende endepunkt-/
modell-/auth-konstruksjon (ingen live nøkler tilgjengelig i dette miljøet for å bekrefte faktisk
respons-body). Ordren var eksplisitt "ikke gjett" - levert TRYGG, begrenset feilsøkingsdiagnostikk i stedet
(`classifyHttpStatus()` nytt valgfritt `diagnostic`-parameter: `provider_error_code`/`sanitized_endpoint`/
`request_operation`, ALDRI nøkkel/auth-header/query-string/prompts - `types.ts`), `GeminiAdapter`/
`KimiAdapter` fyller det fra faktisk feilrespons-body (`extractProviderErrorCode()`). **E (ScriptedAdapter
produksjonslekkasje):** live-bevist `scripted:true` i `PAID_MODELS_DISABLED_PROVIDERS_INVOKED` - test-
dobbelen var registrert i `main.ts` sin PRODUKSJONS-`ModelGateway`, kunne under `paid_models_allowed=false`
uten ekte lokal provider bli et legitimt rutingvalg og returnere et FAKE svar i produksjon. Fjernet helt fra
produksjonswiring (`worker-main.ts` registrerte den aldri, bekreftet) - tester konstruerer den eksplisitt
selv, uendret etablert mønster. `paid_models_allowed=false` + ingen ekte lokal provider feiler nå ÆRLIG med
den eksisterende `PaidModelsDisabledError` (uendret logikk, kun konsekvensen av en fjernet fake-kandidat).
**Testdekning (40 nye tester, 2 nye filer + 2 utvidede):** `conformance.test.ts` (+16 - 4 URL-former for A +
malformert-sti-bevaring + 6 diagnostikk-tester for B inkl. eksplisitt hemmelighet-lekkasje-negativ-bevis og
modellnavn/URL-UENDRET-bevis). `d106-router-extensions.test.ts` (+7, O-U - tiebreak avgjør uavgjortet,
registrerings-rekkefølge-uavhengighet, eskalering til betalt for vanskelig purpose FORTSATT fungerer,
eksplisitt override for alle fem familier, usunn Gemma blokkerer ALDRI eskalering, `paid_models_allowed=
false` uendret håndhevet). `d106-council-json-extraction.test.ts` (NY, 14 - alle åtte formateringsklassene
ordren listet eksplisitt). `d106-scripted-adapter-production-wiring.test.ts` (NY, 3 - kildetekst-inspeksjon
av BÅDE `main.ts`/`worker-main.ts` + et rent routing-bevis for den ærlige feilkonsekvensen). Full
workspace-suite re-kjørt ÉN gang etter alle fem fikser: `153/153`filer/`2344/2344`tester, INGEN feil, INGEN
kjent flake denne kjøringen. `pnpm -w typecheck` 19/19 rent, `pnpm -w lint` rent. **ÆRLIG STATUS per fiks:**
`GEMMA_URL_NORMALIZATION_FIXED=true`, `GEMMA_FIRST_DETERMINISTIC=true`,
`REGISTRATION_ORDER_INDEPENDENT=true` (begge `FIXED_SUITE_VERIFIED`, ingen ny host-live-kjøring utført denne
runden - se DELIVERY under), `COUNCIL_STRUCTURED_OUTPUT_FIXED=true` (re-audit 2026-08-23: kravet var en
robust, deterministisk, provider-nøytral parser med streng skjemavalidering - IKKE nødvendigvis
provider-native modus - og tekst-parseren oppfyller beviselig alle åtte kravklassene + skjema-strenghet +
ingen fabrikasjon; 4 nye ende-til-ende-tester i `council.test.ts` (U-X) beviser DEN FAKTISKE
rundeprotokollen, ikke bare `extractJson()` isolert, håndterer messy-fenced/bounded-prose-formatering
repeterbart - provider-native modus forblir bevisst utelatt), `GEMINI_ADAPTER_FIXED=false`/
`KIMI_ADAPTER_FIXED=false`/`GEMINI_LIVE_VERIFIED=false`/`KIMI_LIVE_VERIFIED=false` (diagnostikk-forbedring
levert i stedet for en gjetning - ærlig uverifisert, IKKE stille markert løst). **Oppfølgingsrunde
(samme dag, 2026-08-23):** en påfølgende ordre krevde en live diagnostisk probe med Tobias sin ekte
konfigurerte nøkkel "via skjult miljøtilgang" - `env`-variabler og filsystemet ble eksplisitt undersøkt for
alle fem leverandørnøkler (`GEMINI_API_KEY`/`KIMI_API_KEY`/`MOONSHOT_API_KEY`/`OPENAI_API_KEY`/
`ANTHROPIC_API_KEY`) og enhver `.env`-fil - INGEN slik tilgang finnes i dette sandbox-miljøet (kun
`.env.example`, ingen secrets), for NOEN av de fem AI Mesh-familiene. Dette er en strukturell
miljøbegrensning, bekreftet ikke antatt - den ordrede live-proben er derfor umulig fra denne økten.
Ytterligere dokumentasjonsforskning bekreftet Kimi/Moonshot sin flaggskipmodell `kimi-k3` som ekte og aktuell
(tre uavhengige redaksjonelle kilder: Bloomberg/TechCrunch/Fortune), men en sekundær hypotese (default-modell
`"kimi-latest"` mulig avviklet ~28. januar 2026) er KUN bekreftet av ikke-primære aggregatorer (primær
Moonshot-dokumentasjon er nettverks-blokkert i dette miljøet) - beviskravet er IKKE oppfylt, så
`KimiAdapter` sin default-modell er BEVISST IKKE endret. `GEMINI_404_ROOT_CAUSE=
unverified_no_adapter_defect_found_credential_and_network_blocked`,
`KIMI_404_ROOT_CAUSE=unverified_hypothesis_kimi_latest_possibly_deprecated_unconfirmed_against_primary_docs`.
DO NOT REGRESS-listen fra ordren bevist uendret av at hele den eksisterende, uendrede test-suiten forble
grønn. `Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false` uendret. INGEN UA-6 startet. Implementert i ordrens
eksakte rekkefølge (A->C->D->B->E->regresjon->docs), ÉN sammenhengende PR fra `origin/main`
(`9d0323a5f70c8060befb5d786e9aecfc32bd6234`) - IKKE splittet i mikro-PR-er. Gjenstående, eksplisitt
IKKE-stille-utelatt live-blokker: ALL live-verifisering (samtlige fem familier, ikke bare Gemini/Kimi) krever
at Tobias kjører en snever akseptanseskript-kjøring PÅ SIN EGEN maskin med sine egne nøkler - samme mønster
som resten av D-106, STRUKTURELT umulig fra denne økten. PR forblir draft, IKKE merget. Full detalj: D-106
HOST-FIX 3 (inkl. fortsettelse) i DECISIONS_AND_ASSUMPTIONS.md.

**Andre oppfølgingsrunde (samme dag, 2026-08-23):** Tobias kjørte den narrow akseptanseskripten faktisk PÅ
SIN EGEN maskin (den "strukturelt umulige" live-proben over ER nå mulig, av Tobias, ikke denne økten selv).
`GEMMA_PRODUCTION_ADAPTER_LIVE=true`/`GEMMA_FIRST_ROUTING_LIVE=true`/`PAID_MODELS_DISABLED_LIVE=true` - EKTE
live-bevist. Kimi-hypotesen over ER NÅ BEKREFTET (ikke lenger kun ikke-primær-kilde): Tobias sin ekte kontos
`/v1/models`-liste bekreftet `"kimi-latest"` finnes IKKE, `kimi-k3` er gjeldende flaggskip -
`KimiAdapter`-default rettet. Council `max_tokens: 1024` bevist for lavt for ekte GPT-5/Anthropic (reasoning-
token-forbruk hhv. avkutting) - hevet til `4096`. Gemini 404 fortsatt IKKE en kodedefekt (modell bekreftet i
katalogen, men nøkkel-entitlement på selve `generateContent` mangler - eksternt). Full detalj: D-106 HOST-FIX
3, fortsettelse 2, i DECISIONS_AND_ASSUMPTIONS.md.

**HOST-FIX (2026-08-22, D-41-korreksjon):** closeout-audit av PR #48 fant at `redeploy_container` sin
sentinel-only-nektelse var en PERMANENT restriksjon på ekte produksjons-mutasjonskapasitet, ikke en
akseptanse-scoping - i strid med D-41. Tobias bekreftet: sentinel er AKSEPTANSE-ONLY, produksjonen skal ha
ekte kapasitet. `assertSentinelTarget()` fjernet fra transporten (transporterer nå kun); ny
`docker-target-policy.ts` (`authorizeDockerTarget()`) håndheves i stedet av `ToolGateway.execute()` selv
(ny generisk `ToolDefinition.parameterAuthorizer`-hook - samme håndhevelsespunkt for alle innslagsveier).
Nye `docker.stop_container`/`docker.start_container` (ren kjøretilstand, bevist trygg) er de
PRODUKSJONS-autoriserte handlingene mot `JARVIS_DOCKER_MUTATION_TARGETS` (eksakt, eier-konfigurert,
fail-closed). `redeploy_container` forblir DEFERRED for produksjon (kun sentinel) - sikkerhetsaudit fant at
nåværende rm-f+run-d-implementasjon ikke bevarer mounts/env/nettverk/porter/restart-policy/healthcheck.
Sovereign eier-autoritet uendret (target-autorisasjon utvider aldri myndighet). Ny
`assertValidContainerName()`/`assertValidImageRef()` kommandoinjeksjonsforsvar. Full detalj: D-105-raden
(HOST-FIX-avsnittet) i DECISIONS_AND_ASSUMPTIONS.md.

**LIVE HOST-AKSEPTANSE §1/§2 (2026-08-22, Tobias sin egen kjøring mot ekte Windows + Docker Desktop):**
`OBSERVABILITY_PROVIDER_LIVE=true`, `REAL_LOG_ACQUISITION=true`, `DB_STATE_CORRELATION_LIVE=true`,
`UA5_CRITERION_3=COMPLETE` (full ekte redeploy/before-after/diff/recovery-syklus mot et disponibelt
sentinel-mål, produksjonscontainere utouched, uavhengig `docker inspect`-verifisering). Gjenstående gap:
`POST /incidents/correlate` fant ingen `active_deployment` - `DeploymentService.recordDeployment()` hadde
ingen produksjons-callsite.

**HOST-FIX #2 (2026-08-22, GitHub deployment-ingestion, samme D-105, ingen ny D-ID):** ny
`modules/incidents/src/deployment-ingestion.ts` (`ingestGithubDeployment()`) er DEN manglende
produksjons-callsiten - henter én Actions-workflow-kjøring UTELUKKENDE via `ToolGateway.execute()`
(`github.get_workflow_run`, aldri direkte HTTP - D-41: gjenbruker eksisterende connector), validerer
strukturelt (manglende/ugyldig `head_sha`/`status`/`created_at` -> `invalid_provider_response`, aldri
fabrikkert), normaliserer deterministisk (konservativ status-mapping; `deployed_at` fra GitHub sitt EKTE
`created_at` - aldri `Date.now()`). `get_workflow_run`-transporten (`live-transports.ts`) utvidet med
`created_at` (manglet før - provider-repair, ikke fabrikkert erstatning). Ny `POST /deployments/ingest/
github`-rute (tenant-scopet, feiler lukket på identitet/provider-feil). `/incidents/correlate` uendret -
bruker samme kanoniske `DeploymentService`, nå med faktisk data etter ingestion. Q-26 uendret: evidence-
forfremmelse skjer KUN via eksisterende `correlateIncident()`-matcheregel. 14 nye HTTP-integrasjonstester
(`apps/api/test/deployment-ingestion-api.test.ts`, ekte `createApiServer()`+`fetch()`+embedded Postgres+
fake GitHub-transport) + 1 transport-test. `FIXED_SUITE_VERIFIED=true`. `DEPLOY_OR_VERSION_CORRELATION_LIVE`
forblir `false`/`UA5_CRITERION_1` forblir `PARTIAL` inntil Tobias kjører runbokens nye §3 (GitHub
deployment-ingestion-akseptanse) mot et ekte `tsworkflow/jarvisbuild`-workflow-run. Full detalj: D-105-raden
(HOST-FIX #2-avsnittet) i DECISIONS_AND_ASSUMPTIONS.md.

**UA-5 KANONISK CLOSEOUT (2026-08-22, Tobias sin egen kjøring av runbokens §3):** ingesterte en ekte
`tsworkflow/jarvisbuild`-Actions-kjøring (`workflow_run_id=32593753550`, `head_sha=63c598ec...` - PR #49 sin
egen merge-commit), bekreftet idempotent (`created=false` andre gang), og `/incidents/correlate` returnerte
en ikke-null `active_deployment` som eksakt matchet den ingesterte deploy-en (`suspect_deployment=null` var
FORVENTET - ingen bevis-tidsvindu registrert på den ferske hendelsen, ikke en mangel).
`DEPLOY_OR_VERSION_CORRELATION_LIVE=true`. `UA5_CRITERION_1=COMPLETE`. Sammen med allerede live-bevist
`UA5_CRITERION_2=COMPLETE` (D-103 run-3), `UA5_CRITERION_3=COMPLETE` (§2 over), `UA5_CRITERION_4=COMPLETE`
(tidligere UA-5-slicer): **`UA5_IMPLEMENTATION_COMPLETE=true`, `UA5_CANONICAL_CLOSEOUT_READY=true`** - alle
fire kriterier er nå `COMPLETE`, INGEN forblir `PARTIAL`. `Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false` UENDRET
(kun den ene eksisterende eksakt-match-forfremmelsesregelen). `PRODUCTION_REDEPLOY_CONTAINER_SAFE=false`
UENDRET - `redeploy_container` forblir DEFERRED for produksjon; sentinel-bevist mutasjon+recovery er et
mekanikk-bevis, IKKE et produksjonssikkerhetsbevis for `redeploy_container`. INGEN kodeendring i denne
closeouten - ren dokumentasjons-/kanoniseringsoppdatering. Full detalj: D-105-raden
(«UA-5 KANONISK CLOSEOUT»-avsnittet) i DECISIONS_AND_ASSUMPTIONS.md.

---

### UA-6 — FINANCE & SPEND INTEGRITY GATEWAY: FØRSTE VERTIKALE SLICE (2026-08-24)

Eksplisitt ordre fra Tobias om å begynne UA-6 - rekonstruert FRA REPOSITORY-SANNHET (masterplan
`docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md` linje 508-523), ikke fra samtalehukommelse.
UA-6 sine fem akseptansekriterier: (1) retry kan aldri dobbeltbetale; (2) hver pengehandling kartlegges
intent→leverandørforespørsel→utfall→regnskap/avstemming; (3) feil konto/leverandør/beløpsformat/duplikat
fanges deterministisk; (4) eksterne BankID/KYC/PSD2-kontroller respekteres; (5) finans-nødbryter stopper
nye transaksjoner umiddelbart. Leverandørprioritet fra masterplanen: Fiken (regnskap) = P0, bank/åpen
bank + Stripe + Vipps = P1, programmerbart kort/wallet = P2.

**Denne sliceen bygger P0 (Fiken) fullstendig vertikalt** - domenemodell→persistens→service/
orkestrering→policy→tenant-isolasjon→ToolGateway→runtime/API-overflate→audit/proveniens→feilhåndtering→
tester→dokumentasjon, samt kriterium 1/2/3/5 for Fiken-sporet (kriterium 4 ikke relevant for et rent
regnskapsspor - ingen betalingsbevegelse, kun bokføring; blir relevant først ved bank/Stripe/Vipps P1).
**Bygges IKKE denne sliceen** (eksplisitt DEFERRED/PARTIAL, aldri stille utelatt): `POST /purchases`
(bilagsregistrering via Fiken - intet pålitelig request-body-skjema kunne D-41-verifiseres); bank/åpen
bank-leverandør (P1); Stripe betalinger/abonnement (P1); Vipps/MobilePay (P1); programmerbart
bedriftskort/wallet (P2); owner-konfigurerbare budsjetter/tak (Sovereign Mode støtter fortsatt ingen
intern kunstig grense - D-41 Owner Connector Capability Invariant uendret).

**D-64-porten kjørt FØRST:** `CAPABILITY=`regnskapsføring/bilagsposering; `JARVIS_CORE=`Payment/Spend
Intent-domenemodell, idempotensgaranti, deterministisk anomalideteksjon, avstemmingstilstand, eier-
nødbryter, audit/proveniens; `EXTERNAL_ROLE=`det offisielle bokførte regnskapet under norsk
bokføringslov; `SYSTEM_OF_RECORD=HYBRID_WITH_CLEAR_AUTHORITY`. `CORE_DEPENDENCY_DECISION_REQUIRED=false`
- Fiken var masterplan-navngitt P0-leverandør, ikke et Claude-valgt bekvemmelighetsvalg (samme presedens
som tidligere Google Ads/Zendesk-klasse-beslutninger).

**D-41-audit (anti-gjetting):** direkte `WebFetch` mot `api.fiken.no` var `EGRESS_BLOCKED` denne økten.
Falt eksplisitt tilbake til Fikens EGEN swagger.json speilet uendret i en GitHub-hostet community-TS-
klient (`bjerkio/fiken-js`) - lavere tillitsnivå (`VERIFIED_SEARCH_SNIPPET`, ikke
`VERIFIED_PRIMARY_SOURCE`), merket som sådan i kildekodekommentarer. Verifisert: OAuth2
`authorization_code`/`refresh_token`-grants mot `https://fiken.no/oauth/{authorize,token}`, scopes
`read`/`write`, personlig API-token (Bearer) som alternativ (IKKE brukt - ekte OAuth valgt for
eierkonto-korrekthet), base `https://api.fiken.no/api/v2`, ressurser adressert via
`/companies/{companySlug}/...`. Les-endepunkter: `/companies`, `/companies/{slug}/contacts`,
`/companies/{slug}/bankAccounts`, `/companies/{slug}/journalEntries`. Skriv-endepunkt:
`POST /companies/{slug}/generalJournalEntries` (fri postering - den generiske journalpost-mekanismen,
IKKE en spesifikk bilag-/faktura-postering). Kontokode-format verifisert som `NNNN` eller `NNNN:NNNNN`
(reskontro).

**Bygget:** migrasjon `038_finance.sql` (`payment_intents`/`payment_intent_events`/`finance_kill_switch`,
full RLS FORCE + tenant/space-policyer på de to første, tenant-only-policy på nødbryteren som BEVISST
ikke er space-scopet - en finans-nødbryter er kontobred, ikke et minnerom-konsept); ny selvstendig pakke
`@jarvis/finance` (`types.ts`/`state-machine.ts`/`fiken-transport.ts`/`service.ts`/`transport.ts`) - egen
`modules/finance`-pakke per etablert konvensjon (`@jarvis/contracts` er ALLEREDE den delte kryssgående
type-kontrakt-pakken, IKKE et domenenavn - samme presedens som `modules/agreements`); state-machine er
BEVISST strengere enn tidligere domener - `settled`/`failed`/`cancelled` er terminal UTEN
admin-korrigeringsvei tilbake til draft, siden en ekte pengehandling ikke kan avposteres. 10 nye
`finance.*` ToolGateway-handlinger (risikoklasse A for lesing, B for interne skrivinger som
opprettelse/kansellering/avstemming, D for `submit_payment_intent` - `reversible:false`, ingen
automatisk rollback bygget denne sliceen - og for `enable_kill_switch`/`disable_kill_switch`).
`OpenLoopService.detectPaymentAnomalies()` (nytt anomali-/avstemmingsavvik-regelsett, samme
upsert-/auto-resolve-mønster som eksisterende growth-/support-/contract-regler). Q-20 erasure-plan
utvidet (`payment_intent_events`/`payment_intents` i minnerom-sletting, filtrert `business_open_loops`-
rad, `finance_kill_switch` i tenant-nivå-sletting siden den ikke er space-scopet). `apps/api`
`main.ts`/`worker-main.ts` wiret identisk (transport + `FikenCredentialsProvider` lest fra
`JARVIS_FIKEN_REFRESH_TOKEN`/`JARVIS_FIKEN_COMPANY_SLUG`-env).

**Tre ekte produksjonsbugs funnet OG fikset via faktisk testkjøring mot embedded Postgres** (ikke bare
kodegjennomgang - nøyaktig den type feilklasse som ville forårsaket en reell produksjonshendelse: en
hengende API-forespørsel under aktiv nødbryter-tilstand):
1. **RLS-brudd på `finance_kill_switch`:** `enableKillSwitch`/`disableKillSwitch`/`getKillSwitch` kalte
   opprinnelig `pool.query()` direkte uten noensinne å sette `jarvis.tenant_id`-sesjonskonfigurasjonen,
   så RLS-policyen sammenlignet mot NULL og avviste hver skriving. Fikset med ny `withTenantContext()`-
   hjelpefunksjon (samme BEGIN/set_config/COMMIT-eller-ROLLBACK/release-mønster som
   `withMemoryTransaction`, minus rom-kravet - en tenant-scopet men bevisst IKKE rom-scopet RLS-
   transaksjonsprimitiv som ikke fantes i `@jarvis/memory` fra før).
2. **`bigint`→streng pg-koersjonsbug:** `amount_ore bigint`-kolonner returneres av `pg` som
   JavaScript-strenger (ingen global OID-20-typeparser registrert noe sted i `@jarvis/core` - samme
   kjente, pre-eksisterende egenskap som allerede påvirker growth sin `spend_amount_ore`, håndtert der
   via eksplisitt `Number()`-cast ved bruksstedet). Fikset identisk: eksplisitt `Number(current.amount_
   ore)`-cast i `submitPaymentIntent()` rett før Fiken-journalpostlinjene konstrueres.
3. **Kryss-tilkoblings FK-radlås-selvlåsing:** første fiksforsøk for nødbryter-hendelse-varighet skrev
   `kill_switch_blocked`-hendelsen via en NØSTET, uavhengig `withMemoryTransaction()`-kall (en andre
   tilkobling) FØR kasting fra den ytre transaksjonen. Dette hang genuint: den ytre transaksjonen holdt
   `SELECT ... FOR UPDATE` på `payment_intents`-raden, og `payment_intent_events.payment_intent_id
   REFERENCES payment_intents` betyr at den nøstede INSERT-en trengte en SHARE-lås på nøyaktig den
   raden - som den ytre (fortsatt åpne, JS-suspenderte) transaksjonen aldri ville sluppet, siden den selv
   ventet på at den nøstede kallets promise skulle løse seg. IKKE en Postgres-detektert deadlock (ulike
   tilkoblinger, men "syklusen" spenner applikasjonslogikk usynlig for Postgres sin deadlock-detektor) -
   den hang bare til timeout. Fikset ved å restrukturere `submitPaymentIntent()` til å skrive hendelsen
   på SAMME `client`/transaksjon (ingen nøstet pool-utsjekking), returnere et diskriminert
   `{ok:true,intent}|{ok:false,error}`-resultat i stedet for å kaste inne i transaksjonskroppen, la
   `withMemoryTransaction` COMMIT-e normalt, deretter pakke ut og kaste `outcome.error` UTENFOR
   transaksjonen etter at den allerede er committet.

**Testmatrise:** 9 rene state-machine-tester, 28 `service-rls.test.ts`-tester mot ekte embedded Postgres
(idempotent opprettelse, deterministisk validering, anomali-flagging, fail-closed innsendingsrekkefølge,
nødbryter, full innsendingsflyt med verifiserte Fiken-kontolinjer, idempotent gjentatt innsending,
terminal-tilstand-avvisning, avstemming, tenant-isolasjon, listefiltrering), 5 `transport-wiring.test.ts`-
tester, 11 `fiken-live-lib.test.ts`-tester, pluss 9 nye `open-loop-finance.test.ts`-tester. **Full
workspace-suite: 160 filer/2456 tester grønt** (opp fra 159/2445 ved forrige D-106-closeout - eksakt
+11 filer/+11 tester, INGEN regresjon). Én isolert hook-timeout på `business-brief.test.ts` under
samtidig full-suite-kjøring ble undersøkt og bekreftet som en kjent ECONNREFUSED-klasse embedded-
Postgres-ressurskonkurranse-flake (18/18 grønt i isolert kjøring av nøyaktig samme fil) - IKKE en
finance-regresjon, ingen produktkode rørt for å "fikse" den. `pnpm -w typecheck` og `pnpm -w lint` rent
hele workspacet.

**Host-akseptanse-infrastruktur bygget** (samme tre-lags mønster som `google-ads-live-host-run.ts`/
`google-ads-live.ts`/`google-ads-live-lib.ts`, skalert mindre til Finance sin smalere P0-overflate):
`modules/finance/scripts/fiken-live-host-run.ts` (avhengighetsfri bootstrap-wrapper - pnpm install,
Docker-images, migrasjoner, restart) → `fiken-live.ts` (~280 linjer - Q-21 runtime-rolle-sjekk FØRST,
deretter beviser HELE JARVIS_CANONICAL-domenet (idempotens/validering/kill-switch/state-machine/
avstemming/tenant-isolasjon) reelt mot Postgres via EKTE `ToolGateway.execute()`, UAVHENGIG av om Fiken-
credentials er konfigurert; KUN hvis credentials finnes: en les-only `listCompanies()`-reachability-probe,
ZERO mutasjon) → `lib/fiken-live-lib.ts` (rene, enhetstestede hjelpefunksjoner - `checkRequiredEnv`/
`isLiveWriteOptedIn`/`evaluateSecretSafety`/`computeHardFail`). **Fiken har INGEN dokumentert sandbox-/
testmodus-konsept** (i motsetning til Stripe) - D-41 sitt blast-radius-krav ("test-/akseptanseløp
begrenses til sandbox/test-ressurser") er derfor strukturelt IKKE oppfyllbart for selve skrivehandlingen
uten at Tobias selv setter opp en dedikert test-bedrift i sin egen Fiken-konto. Akseptansescriptet
forsøker derfor ALDRI et ekte `submit`-skriveforsøk, selv med eksplisitt opt-in
(`JARVIS_FIKEN_HOST_ACCEPTANCE_ALLOW_LIVE_WRITE=true`) - selve skrive-verifiseringen er BEVISST utsatt
til en fremtidig slice der Tobias interaktivt oppgir en ekte Fiken-kontakt-ID/motkonto (utenfor denne
sliceens omfang).

**Terminalflagg:** `UA6_STARTED=true`, `UA6_COMPLETE=false` (kun P0/Fiken-sporet av fem
akseptansekriterier bygget for kun én av tre planlagte leverandørspor; P1/P2 ikke startet).
`FIXED_SUITE_VERIFIED=true`, `LIVE_VERIFIED=false` (avventer Tobias sin host-kjøring av
`fiken-live-host-run.ts`). `Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false` UENDRET - ingen ny
selvrapportert-sannhet-forfremmelsesregel innført av dette domenet. Egen PR fra `origin/main`
(branch `claude/ua6-finance-core-fiken`), IKKE merget. Full detalj: D-107 i
DECISIONS_AND_ASSUMPTIONS.md.

---

### UA-6 Finance & Spend Integrity Gateway — ANDRE slice (Slice 2, 2026-08-25)

Base `main=7d4ef43c8e4e2f83db1a1ce24845f2e311a41bd5` (PR #57 merget). ZERO ny ekstern
leverandør, ZERO nye credentials (D-108 uendret) - HELE sliceen er `JARVIS_CANONICAL` mot to
ALLEREDE eksisterende interne kilder Jarvis eier: `marketing_spend_events` (@jarvis/growth) og
`cost_events` (@jarvis/model-gateway). Omfang: deterministisk synk av begge kildene til en NY,
dedikert `finance_spend_records`-tabell; abonnements-/gjentakende forpliktelsesregister;
anskaffelses-/forventet-utgifts-register; deterministisk avviksdeteksjon (alle 7 typer fra
byggeordrens §8); avstemming/matching; OpenLoop-surfacing (fem nye loop_type-verdier).

**§2-designvalg (dokumentert her, INGEN ny D-beslutning - byggeordrens egen tillatelse):**
dedikert `finance_spend_records`-tabell fremfor gjenbruk av `payment_intents`. `payment_intents`
modellerer en FREMTIDIG, eier-initiert betalingsintensjon med en eksplisitt provider-
innsendings-lifecycle (draft -> submitted -> ...) og et eier-oppgitt `idempotency_key`. Observert
intern utgift (annonseforbruk/AI-API-kostnad) har INGEN slik lifecycle - den har ALLEREDE skjedd,
kommer fra en eksisterende kildetabell med SIN EGEN idempotens-nøkkel, og skal ALDRI "sendes inn"
noe sted. En egen tabell bevarer begge domenenes presise betydning uten å korrumpere
`payment_intents` sin state-machine/semantikk.

Ny migrasjon `039_finance_spend_integrity.sql`: `finance_recurring_commitments`,
`finance_procurement_items`, `finance_spend_records`, `finance_spend_sync_cursors` (RLS/GRANT-
mønster identisk med `038_finance.sql`), pluss additiv utvidelse av `business_open_loops`
(to nye nullable FK-pekerkolonner + fem nye `loop_type`-verdier). Ny `SpendService`
(@jarvis/finance): cursor-basert inkrementell synk for begge kilder (`syncMarketingSpend()`
sporer `marketing_spend_events.updated_at` - fanger BÅDE ny historikk OG sen-korrigerte eldre
rader; `syncModelCost()` sporer `cost_events.cost_id`, append-only kilde, INGEN korrigering
mulig/nødvendig), forpliktelses-/anskaffelses-CRUD + deterministiske state-maskiner
(`spend-state-machine.ts`), `runAnomalyDetection()` (ren SQL, full erstatning av `anomaly_flags`
per kjøring - selv-korrigerende, aldri stille akkumulerende), `matchAndReconcile()` (ambiguity-
safe CTE: flere kandidat-forpliktelser for samme kilde-signatur etterlater raden ULØST). Ny
`SpendTransport` (`finance_spend.*`-ToolGateway-namespace, 18 handlinger, KUN klasse A/B - INGEN
provider-kall i dette namespacet, `JARVIS_BUSINESS_INTERNAL_TOKEN`-sentinel som resten av interne
finance-handlinger). `OpenLoopService` (@jarvis/business) fikk fem nye SURFACE-metoder (leser
allerede-beregnede avviksflagg, beregner INGENTING selv - samme rollefordeling som
`detectPaymentAnomalies()`). Ny DailyScheduler-jobb `finance-spend-integrity-sweep` (kl. 04, FØR
`business-open-loop-sweep` kl. 06 slik at de nye OpenLoop-reglene ser ferske flagg).
§13 kill switch-distinksjon implementert og testet: `finance_kill_switch` rører ALDRI
`SpendService` (REN passiv observasjon/regnskap - kun `FinanceService.submitPaymentIntent()`,
en AKTIV pengeutførelse, gates av nødbryteren).

**Tre reelle defekter funnet og rettet av ekte Postgres-integrasjonstester** (ikke antatt
riktig ved skriving):
1. **`timestamptz`-cursor-presisjonstap:** `marketing_spend_events.updated_at` har mikrosekund-
   presisjon i Postgres, men JS `Date` (som pg sin type-parser konstruerer den TIL, og som
   cursoren derfor lagres FRA via `.toISOString()`) har KUN millisekund-presisjon. Uten avkorting
   på BEGGE sider av sammenligningen ville en rad med et mikrosekund-restledd ALLTID vært "større
   enn" sin egen (avkortede) cursor-verdi - en uendelig re-synk-sløyfe som aldri konvergerer mot
   `scanned=0`. Fikset med `date_trunc('milliseconds', updated_at)` på begge sider.
2. **`matchAndReconcile()` sin opprinnelige per-forpliktelse-løkke** kunne stille koble en
   utgift til FEIL forpliktelse når flere aktive forpliktelser delte samme `source_mapping`-
   kildesignatur (f.eks. to forpliktelser begge mappet til samme `campaign_id`) - "hvilken som
   helst forpliktelse iterasjonen traff først" vant stille, i strid med byggeordrens eget §9-krav
   ("never silently merge ambiguous records"). Erstattet med en ambiguity-safe CTE
   (`HAVING count(DISTINCT commitment_id) = 1`).
3. **Erasure-plan FK-ordringsdefekt:** den nye finans-utgifts-blokken var opprinnelig plassert
   ETTER `marketing_campaigns`-slettingen (samme relative posisjon som den EKSISTERENDE
   `payment_intents`-blokken, som IKKE har noen FK mot `marketing_campaigns`) - men
   `finance_spend_records.campaign_id` ER en FK mot `marketing_campaigns`, og måtte derfor slettes
   FØR. Fanget av `growth-erasure.test.ts` sin schema-drevne `information_schema`-FK-audit
   (oppdatert til å kjenne igjen den nye, KORREKT-registrerte avhengigheten), IKKE antatt riktig.

**Testmatrise:** `spend-service.test.ts` (30 tester mot ekte embedded Postgres - kilde-synk,
pengeintegritet, register-CRUD/state-maskiner, alle 7 avvikstyper, avstemming, kill-switch-
distinksjon, full sveip-idempotens), `open-loop-finance-spend.test.ts` (12 tester - de fem nye
loop_type-reglene, auto-resolve, tenant-isolasjon), `finance-spend-erasure.test.ts` (2 tester -
ekte `ErasureService.executeErasure()` inkl. den rettede FK-rekkefølgen, + tenant-only
cursor-tabellen), `spend-transport-wiring.test.ts` (6 tester - ToolGateway-registrering/
risikoklasser/dispatch). **Full workspace-suite: 165 filer/2550 tester grønt** (opp fra 160/2456
ved D-107 FØRSTE-slice-closeout). `pnpm -w typecheck` og `pnpm -w lint` rent hele workspacet.

**Host-akseptanse-infrastruktur bygget** (samme tre-lags mønster som `fiken-live-host-run.ts`/
`fiken-live.ts`): `modules/finance/scripts/spend-integrity-live-host-run.ts` (avhengighetsfri
bootstrap-wrapper) → `spend-integrity-live.ts` (12 markører, INGEN credentials nødvendig -
`finance_d107_invariant_preserved` re-verifiserer D-107 FØRSTE-slice-idempotens PARALLELT med de
ti nye Slice 2-markørene per byggeordrens §16-krav). Kjørt i denne økten mot en ekte lokal
Postgres via et embedded-postgres-harness (IKKE Docker) - alle 12 markører PASS. Ekte
docker-compose-full-stack-kjøring på Tobias sin Windows-host gjenstår.

**Terminalflagg:** `UA6_FIRST_SLICE_COMPLETE=true`, `UA6_SLICE2_IMPLEMENTATION_COMPLETE=true`,
`UA6_COMPLETE=false` (P1/Stripe-Vipps-bank og P2/kort-wallet fortsatt ikke startet).
`FIXED_SUITE_VERIFIED=true`, `LIVE_VERIFIED=false` (avventer Tobias sin host-kjøring).
`Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false` UENDRET. `NEW_EXTERNAL_PROVIDERS=NONE`,
`NEW_CREDENTIALS_REQUIRED=false`, `D108_DEFERRED_POLICY_PRESERVED=true`. Egen PR fra
`origin/main` (branch `claude/ua6-slice2-internal-spend-sync`), IKKE merget.

---

### UA-6 Finance & Spend Integrity Gateway — TREDJE slice (Slice 3, D-109): Stripe (2026-08-25)

Ny ekstern leverandør (P1, masterplan-navngitt sammen med Vipps/bank - `CORE_DEPENDENCY_DECISION_
REQUIRED=false`). D-64-porten kjørt FØRST: `SOR=HYBRID_WITH_CLEAR_AUTHORITY` - Jarvis eier
betalings-/refusjons-intensjon, dobbelt idempotens (egen DB-tilstand + deterministisk avledet
Stripe `Idempotency-Key`), provider-avviksdeteksjon, avstemmingstilstand, nødbryter og audit; Stripe
eier selve PaymentIntent-/Charge-/Refund-provider-tilstanden og webhook-hendelses-identiteten.
D-41-audit: primærkilder (`docs.stripe.com` m.fl.) `EGRESS_BLOCKED`, falt tilbake til uavhengig
`WebSearch`, merket `VERIFIED_SEARCH_SNIPPET`.

**Omfang bygget:** migrasjon `040_stripe.sql` (utvider `payment_intents` med provider-observasjons-
kolonner, relakserer Fiken-spesifikke CHECK-constraints til å være provider-betinget, to nye
tabeller `stripe_webhook_events`/`stripe_refunds`); `FinanceService` utvidet med Stripe-utførelse
(PaymentIntent UTEN betalingsmetode-innsamling, siden ingen kunde-vendt UI finnes i denne backend-
automasjonskonteksten - deterministisk `provider_acknowledged`, ALDRI antatt `succeeded`),
refusjon (gjenbruker EKSISTERENDE `payment_intents`-state-machine direkte, `StripeRefundState =
PaymentIntentState`), webhook-ingestion (rå body, HMAC-SHA256-signaturverifisering, event-ID-
idempotens, fail-closed tenant-krysssjekk), eksplisitt/hendelsesdrevet utfallssynk gjennom ÉN
delt, ordens-voktet domenesti (`applyStripePaymentOutcome`), 7-type deterministisk provider-
avviksdeteksjon (skrevet til DEN EKSISTERENDE `payment_intents.anomaly_flags` - `OpenLoopService.
detectPaymentAnomalies()` overflater det AUTOMATISK, INGEN ny OpenLoop-kode). 7 nye `finance_stripe.*`
ToolGateway-handlinger; `/webhooks/stripe`-HTTP-rute (rå `Buffer`, IKKE via den JSON-parsende
`readBody()`); `stripe-payment-sync`-DailyScheduler-jobb (kl. 03, FØR `finance-spend-integrity-
sweep` kl. 04); erasure-plan utvidet (`stripe_webhook_events`/`stripe_refunds` FØR `payment_intents`,
samme FK-ordens-regel som `payment_intent_events`); `apps/api/main.ts`/`worker-main.ts`/`server.ts`
wiret identisk i begge prosesser.

**Enkelt-global-Stripe-konto-mønster** (SAMME "single-owner, ikke multi-kunde-SaaS" som Fiken/
GitHub/Google Ads): ett `JARVIS_STRIPE_SECRET_KEY`/`_WEBHOOK_SECRET` + ny `JARVIS_STRIPE_TENANT_ID`.
Ekte Stripe Connect (fler-konto) BEVISST IKKE bygget denne sliceen - men fail-closed tenant-
krysssjekk på ethvert provider-objekt-oppslag ER implementert og bevist (standard, ikke-Connect
Stripe-webhooks bærer uansett INGEN kontofelt).

**Tre reelle produksjonsdefekter funnet og rettet av ekte Postgres-integrasjonstester** (ikke
antatt riktig ved skriving): (1) `CreatePaymentIntentInput` manglet et `provider`-felt i det hele
tatt - `createPaymentIntent()` kunne ALDRI faktisk opprette en Stripe-styrt rad (DB-defaulten
`'fiken'` ble alltid brukt); lagt til som valgfritt felt (byte-for-byte bakoverkompatibelt) +
`validateCreateInput()` gjort provider-betinget for Fiken sitt strenge kontokodeformat. (2)
`refreshStripePaymentState()` brukte `Math.floor(Date.now()/1000)` som ordens-tidsstempel mot en
millisekund-presis `timestamptz`-kolonne - en oppfrisking i SAMME kalender-sekund som en
forutgående innsending kunne spuriøst avvises som en eldre hendelse; fikset med `Math.ceil` for
oppfriskings-stien OG en sekund-avkortet sammenligning i selve ordens-vokteren (ekte Stripe-
webhook-tidsstempler er selv kun hele-sekunds-presise). (3) `createStripeRefund()` sin aggregerte
refusjonsbeløp-spørring kombinerte `SUM(...)` med `FOR UPDATE` - ugyldig Postgres-syntaks, ville
feilet i PRODUKSJON; fjernet (TOCTOU-vinduet er allerede lukket av radlåsen på foreldre-raden).

**Testmatrise:** 77 nye Stripe-spesifikke tester (`stripe-service.test.ts` 51 mot ekte embedded
Postgres/RLS - PAYMENT/SYNC/WEBHOOK/REFUND/SECURITY/ANOMALY/WORKER/CLEANUP, `stripe-webhook.test.ts`
16 rene signatur-/envelope-enhetstester, `stripe-transport-wiring.test.ts` 9 wiring-/
risikoklasse-/bakoverkompatibilitetstester). **Full workspace-suite: 169 filer/2632 tester grønt**,
typecheck/lint rent hele repoet.

**Guardet host-akseptanse-infrastruktur bygget** (`modules/finance/scripts/stripe-live-host-run.ts`
→ `stripe-live.ts`): krever BEVISST INGEN Stripe-credentials (D-108) - en skriptbar
`StripeTransportFactory`-fake injiseres ved Stripe-transportens nettverksgrense; beviser hele
FinanceService/ToolGateway/webhook-HTTP-rute-wiringen mot en EKTE Postgres/runtime-rolle. 14
markører (`stripe_adapter_wiring` t.o.m. `stripe_cleanup` + `finance_d107_invariant_preserved`/
`finance_slice2_invariants_preserved`) - IKKE kjørt på Tobias sin faktiske host ennå.

**Terminalflagg:** `UA6_COMPLETE=false` (tredje av flere slices - bank/Vipps/kort-wallet ikke
startet). `FIXED_SUITE_VERIFIED=true`, `STRIPE_LIVE_VERIFIED=false`,
`STRIPE_LIVE_GATE=PENDING_CREDENTIALS`. `Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false` UENDRET.
Full detalj: D-109 i DECISIONS_AND_ASSUMPTIONS.md.

### UA-6 Finance & Spend Integrity Gateway — FJERDE slice (Slice 4, D-110): Vipps MobilePay (2026-08-25)

Ny ekstern leverandør (P1, masterplan-navngitt sammen med Stripe/bank - `CORE_DEPENDENCY_DECISION_
REQUIRED=false`). D-64-porten kjørt FØRST: `SOR=HYBRID_WITH_CLEAR_AUTHORITY` - Jarvis eier
betalings-/capture-/refusjons-intensjon, dobbelt idempotens (egen DB-tilstand + Vipps sin egen
`Idempotency-Key`), aggregat-oppgjørslogikken, provider-avviksdeteksjon, avstemming, nødbryter og
audit; Vipps eier selve betalings-/capture-/refund-/cancel-provider-tilstanden og webhook-
hendelses-identiteten. D-41-audit: `developer.vippsmobilepay.com` `EGRESS_BLOCKED`, uavhengig
`WebSearch`-fallback, merket `VERIFIED_SEARCH_SNIPPET`. **API-produkt:** ePayment API
(`/epayment/v1/*`) - Vipps sitt anbefalte API for nye integrasjoner (eldre eCom/PSP IKKE brukt).

**Omfang bygget:** migrasjon `041_vipps.sql` (provider-CHECK -> 'vipps', `latest_vipps_event_key`,
ny `captured`-event-type, tre nye tabeller `vipps_webhook_events`/`vipps_captures`/`vipps_refunds`
med full RLS FORCE); `vipps-transport.ts` (fetch-basert, to-stegs accesstoken-auth innkapslet,
INGEN SDK); `vipps-webhook.ts` (Azure-stil HMAC-SHA256-forespørselssignering - Host/X-Ms-Date/
X-Ms-Content-Sha256/Authorization, FUNDAMENTALT annerledes enn Stripe, egen implementasjon);
`FinanceService` utvidet: Vipps-innsending (deterministisk `provider_acknowledged` med
`provider_status='CREATED'` - VENTER-PÅ-BRUKER-tilstanden i Vipps-appen er SANNFERDIG modellert,
aldri antatt fullført), capture som førsteklasses økonomisk handling (delvis/full, over-capture
avvist deterministisk FØR provider-kall, aggregat-oppgjør via `checkVippsFullSettlement()` - Vipps
sitt `payment.state` forblir 'AUTHORIZED' selv etter capture, så oppgjør avgjøres av Jarvis sin
EGEN capture-bokføring), cancel (lokal før innsending / provider-kall etter, frigjør reservasjon),
refusjon (mot oppgjort beløp, samme aggregat-vokter), webhook-ingestion (idempotencyKey-basert
dedup med deterministisk fallback, fail-closed tenant-krysssjekk, ordens-voktet
`applyVippsPaymentOutcome` med ms-presisjon), 10-type avviksdeteksjon (gjenbrukte + nye typer,
skrevet til SAMME `payment_intents.anomaly_flags` - OpenLoopService fanger dem UTEN ny kode),
`syncPendingVippsPayments`-worker-sveip. 12 nye `finance_vipps.*` ToolGateway-handlinger (A/B/C
for cancel_payment/D for submit_capture+submit_refund); `/webhooks/vipps`-HTTP-rute;
`vipps-payment-sync`-DailyScheduler-jobb; erasure-plan utvidet (tre Vipps-tabeller FØR
`payment_intents`); main.ts/worker-main.ts wiret identisk.

**Testmatrise:** 70 nye Vipps-tester (`vipps-service.test.ts` 44 mot ekte embedded Postgres/RLS,
`vipps-webhook.test.ts` 18 rene enhetstester, `vipps-transport-wiring.test.ts` 8). Én selvfanget
designfeil rettet FØR test (duplisert 'captured'-event ved idempotent capture-retry).

**Guardet host-akseptanse** (`vipps-live-host-run.ts` → `vipps-live.ts`): krever INGEN
Vipps-credentials (D-108) - 19 markører inkl. `stripe_slice3_invariants_preserved` (Stripe-grenen
bevist UENDRET av dette tillegget) - kjøres på Tobias sin host ved PR-closeout.

**Terminalflagg:** `UA6_COMPLETE=false` (fjerde slice - bank/kort-wallet ikke startet).
`VIPPS_LIVE_VERIFIED=false`, `VIPPS_LIVE_GATE=PENDING_CREDENTIALS`,
`VIPPS_CREDENTIAL_SETUP_DEFERRED=true`. `Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false` UENDRET.
Full detalj: D-110 i DECISIONS_AND_ASSUMPTIONS.md.

### UA-6 Finance & Spend Integrity Gateway — FEMTE slice (Slice 5, D-111): Neonomics Open Banking (2026-08-26)

Ny ekstern leverandør (Tobias-godkjent primær bank-/open-banking-leverandør, masterplan-P1 «bank» -
`CORE_DEPENDENCY=false`). D-64-porten kjørt FØRST: `SOR=HYBRID_WITH_CLEAR_AUTHORITY` - Jarvis eier
den kanoniske bankdomene-tilstanden (samtykke-livssyklus, kanoniske kontoer/saldo/transaksjoner med
EKSPLISITT debit/kredit-retning, deterministisk avstemming, avviksdeteksjon, PIS-intensjon via
eksisterende `payment_intents`, idempotens, nødbryter, audit); Neonomics eier selve PSD2-tilgangen
(de er den LISENSIERTE TPP-en (AISP+PISP) - Jarvis trenger ingen egen konsesjon), provider-
sesjons-/betalings-identiteten og SCA-utførelsen hos banken (alltid en brukerhandling). D-41-audit:
`docs.neonomics.io` `EGRESS_BLOCKED`, uavhengig `WebSearch`-kryssverifisering, merket
`VERIFIED_SEARCH_SNIPPET`.

**Omfang bygget:** migrasjon `042_neonomics.sql` (provider-CHECK -> 'neonomics',
`latest_neonomics_event_key`, fem nye tabeller `bank_consents`/`bank_accounts`/
`bank_account_balances`/`bank_transactions`/`neonomics_webhook_events` med full RLS FORCE,
`business_open_loops`-CHECK utvidet); `neonomics-transport.ts` (fetch-basert, INGEN SDK, OAuth2
client_credentials + obligatorisk `x-device-id`, 1426/1428 som typede flytsignaler, eksakt
desimal->øre-strengparsing - aldri flyttall-penger); `banking-service.ts` (AIS: samtykke med
CSRF-/replay-beskyttet callback-state, idempotent kontodiscovery med maskert identifikator,
append-only saldo, paginert transaksjonssynk med pending->booked-overgang på SAMME rad og
korreksjonsflagg; deterministisk avstemming REGEL 1 provider-referanse / REGEL 2
eksakt-én-kandidat beløp+datovindu, tvetydig forblir uløst; bank-avviksdeteksjon selv-
korrigerende); `FinanceService` utvidet (neonomics-gren i `submitPaymentIntent` med deterministisk
`endToEndReference = payment_intent_id`, SCA-ventetilstand SANNFERDIG modellert, statussynk der
KUN ACSC/ACCC -> settled, webhook-ingestion med API-nøkkel-auth (Neonomics sin EGEN kontrakt -
IKKE HMAC), ordens-vokter + terminal-bevaring, provider-avviksdeteksjon, worker-sveip);
OpenLoopService +2 regler (`bank_transaction_unmatched`/`bank_consent_attention`); 19 nye
`finance_neonomics.*` ToolGateway-handlinger (A/B/C for revoke_consent - INGEN egen D og INGEN rå
provider-proxy: pengebevegelsen bor i `finance.submit_payment_intent`); `/webhooks/neonomics`-rute;
`neonomics-sweep`-DailyScheduler-jobb; erasure-plan utvidet (5 banktabeller); main.ts/
worker-main.ts wiret identisk.

**Testmatrise:** 52 nye Neonomics-tester (`neonomics-service.test.ts` 30 mot ekte embedded
Postgres/RLS, `neonomics-webhook.test.ts` 15 rene enhetstester,
`neonomics-transport-wiring.test.ts` 7); full workspace-suite 175 filer/2754 tester grønn.

**Guardet host-akseptanse** (`neonomics-live-host-run.ts` → `neonomics-live.ts`): krever INGEN
Neonomics-credentials (D-108) - 23 markører inkl. fire slice-invariant-bevaringer
(`finance_d107_invariant_preserved`/`finance_slice2_invariants_preserved`/
`stripe_slice3_invariants_preserved`/`vipps_slice4_invariants_preserved`) - BESTÅTT på Tobias sin
ekte host 2026-08-26 mot PR #61 sin CI-grønne head `b733a26`: `run_id=6b99ca26`, alle 23 markører
PASS, `hard_fail=false`, ingen host-fix-runde nødvendig.

**Terminalflagg:** `UA6_COMPLETE=false` (femte slice - kort/wallet ikke startet).
`NEONOMICS_LIVE_VERIFIED=false`, `NEONOMICS_LIVE_GATE=PENDING_CREDENTIALS`,
`NEONOMICS_CREDENTIAL_SETUP_DEFERRED=true`, `NEONOMICS_WEBHOOK_SUPPORT=implemented`.
`Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false` UENDRET.
Full detalj: D-111 i DECISIONS_AND_ASSUMPTIONS.md.

### UA-6 Finance & Spend Integrity Gateway — SJETTE slice (Slice 6, D-112): Wallester programmerbare kort (2026-08-26)

Ny ekstern leverandør (Tobias-godkjent primær kort-/wallet-leverandør, masterplan-P1 «kort/wallet» -
`CORE_DEPENDENCY=false`). D-64-porten kjørt FØRST: `SOR=HYBRID_WITH_CLEAR_AUTHORITY` - Jarvis eier
den kanoniske kortdomene-tilstanden (kortformål/eierpolicy, ØNSKEDE spend-grenser, prosjekt-/
leverandør-binding, deterministisk avstemming, avviksdeteksjon, nødbryter, audit); Wallester eier
faktisk utstedt kortidentitet, provider-livssyklustilstand, nettverks-autorisasjonsbeslutninger,
transaksjons-/oppgjørstilstand, provider-saldo og webhook-hendelsesidentitet (de er selv lisensiert
finansforetak - estisk e-pengeinstitusjon, Visa Principal Member - Jarvis trenger ingen egen
konsesjon). D-41-audit: `docs.wallester.com`/`wallester.com`/`api-frontend.wallester.com`/
`deepwiki.com` ALLE `EGRESS_BLOCKED`, uavhengig `WebSearch`-kryssverifisering, merket
`VERIFIED_SEARCH_SNIPPET`. **Sanntidsautorisasjon (§10): NOT_APPLICABLE** - Wallester-webhooks er
varsler om beslutninger Wallester selv fatter, IKKE beslutnings-callbacks - ærlig rapportert, aldri
fabrikkert.

**Omfang bygget:** migrasjon `043_wallester.sql` (provider-CHECK -> 'wallester', seks nye tabeller
`provider_cards`/`card_spend_policies`/`card_events`/`card_authorizations`/`card_transactions`/
`wallester_webhook_events` med full RLS FORCE + RESTRICTIVE space-policyer, `business_open_loops`-
CHECK utvidet med `card_anomaly_attention`); `wallester-transport.ts` (fetch-basert, INGEN SDK,
RS256-JWT per forespørsel signert med kundens PRIVATE RSA-nøkkel, `rbh` = base64(sha256(request-body
som BINÆR)), retry/backoff på 429/500/502/503/504); `card-types.ts` (provider-nøytral kortmodell,
deterministisk tilstandsmaskin draft->pending_provider->active<->frozen->closed,
`mapWallesterCardState()`); `wallester-webhook.ts` (HTTP Basic-verifisering konstant-tid +
envelope-parsing); `card-service.ts` (opprettelse med deterministisk idempotens, livssyklus der
provider-feil ALDRI endrer kanonisk tilstand, ØNSKET vs PROVIDER-ANVENDT spend-policy-splitt - INGEN
kunstig global Jarvis-beløpstak, autorisasjon->oppgjør korrekt modellert - ALDRI dobbel-telling,
transaksjonssynk med paginering/dedup, formålsbundet avstemming REGEL 1 forpliktelse > REGEL 2
eksakt-én-kandidat-beløp, selv-korrigerende avviksdeteksjon (14 typer), webhook-ingestion delt med
polling via samme `ingestTransaction()`); `wallester-sweep.ts` (DailyScheduler kl. 05, per-steg-
feilisolasjon); 18 nye `finance_wallester.*` ToolGateway-handlinger (A lesinger, B lokale
mutasjoner/synk, C spend-muliggjørende submit_card/unfreeze_card/update_spend_policy/close_card -
INGEN egen D, INGEN rå provider-proxy); `/webhooks/wallester`-rute; OpenLoop-integrasjon
(`detectCardAnomalies()`, ny loop-type); erasure-plan utvidet (6 korttabeller, MÅ slettes FØR BÅDE
`finance_recurring_commitments` OG `marketing_campaigns` - `provider_cards.commitment_id`/
`campaign_id`-FK-ene); main.ts/worker-main.ts wiret identisk.

**Testmatrise:** 54 nye Wallester-tester (`wallester-service.test.ts` 36 mot ekte embedded
Postgres/RLS, `wallester-webhook.test.ts` 12 rene enhetstester inkl. JWT/rbh-kontrakten mot ekte
RSA-nøkkelpar, `wallester-transport-wiring.test.ts` 6) - ALLE grønne på FØRSTE kjøring (Slice 5-
lærdommen om proaktiv `beforeEach`-tabell-tømming anvendt fra start). Full workspace-suite grønn
etter én reell regresjonsrettelse: den schema-drevne FK-audit-testen i `growth-erasure.test.ts`
fanget at `provider_cards.campaign_id` sto som en NY, uregistrert ekstern FK inn mot
`marketing_campaigns` - erasure-planens rekkefølge var FEIL (kortblokken sto etter BÅDE
`finance_recurring_commitments` OG `marketing_campaigns`, ikke før) - rettet ved å flytte hele
kortblokken foran begge FK-målene i `plan.ts`, samme mønster/lærdom som `finance_spend_records`
(Slice 2) allerede dokumenterer i samme fil.

**Guardet host-akseptanse** (`wallester-live-host-run.ts` → `wallester-live.ts`): krever INGEN
Wallester-credentials (D-108) - 24 markører inkl. fem slice-invariant-bevaringer
(`finance_d107_invariant_preserved`/`finance_slice2_invariants_preserved`/
`stripe_slice3_invariants_preserved`/`vipps_slice4_invariants_preserved`/
`neonomics_slice5_invariants_preserved`) og `wallester_realtime_authorization_policy` hardkodet
`UNVERIFIED_PRODUCT_ENTITLEMENT` (aldri PASS/FAIL - korrigert D-113, se under). **HOST-AKSEPTANSE:
VENTER** - kjøres av Tobias mot eksakt CI-grønn PR-head; oppdateres i docs-closeouten FØR
merge-godkjenning.

**D-113 (2026-08-27, primærkilde-kontrakt-korrigering FØR host-akseptanse):** Tobias sin
uavhengige gjennomgang av Wallester-dokumentasjon fant to mulige avvik. Funn 1 (auth-kontrakt)
BEKREFTET og RETTET mot en EKTE primærkilde (`github.com/wallester/integration-examples`,
Wallester sitt eget offisielle referanse-repo, klonbart selv om `docs.wallester.com`/
`api-frontend.wallester.com`/`api-doc.wallester.com` fortsatt er `EGRESS_BLOCKED`): `sub`-claimen
skal være den faste literalen `"api-request"` (ikke utsteder-ID-en) og `Authorization`-headeren
skal være `"Bearer <JWT>"` (manglet prefikset) - begge rettet i `wallester-transport.ts` med ny
regresjonstest. Funn 2 (sanntidsautorisasjon) kunne IKKE bekreftes ELLER avkreftes gjennom noen
tilgjengelig kanal - §10 sin klassifisering endret fra `NOT_APPLICABLE` til
`UNVERIFIED_PRODUCT_ENTITLEMENT` (ærligere: fravær av bekreftelse, ikke bekreftet fravær).
Full detalj: D-113 i DECISIONS_AND_ASSUMPTIONS.md.

**D-114 (2026-08-27, PR #62 runde 4, `PRIMARY_SOURCE_EVIDENCE_MODE=OWNER_PROVIDED_PRIMARY_SOURCE_AUDIT`):**
Tobias sin eier-leverte primærkilde-audit avdekket at Wallester publiserer TO DISTINKTE API-produkter
(Business, det VALGTE produktet, vs Card API) - D-113 sin retting gjaldt feil produkt (Card API). Hele
Business-kontrakten erstattet: auth (api_key/ts/RS256/Bearer, INGEN iss/aud/sub/exp/rbh, INGEN
X-Product-Code/X-Audit-*-headere), kortopprettelse (`type: "Virtual"|"ChipAndPin"` + `is_disposable`,
fysisk kort FAIL-CLOSED), livssyklus (PATCH ikke POST), grenser/sikkerhet (to separate PATCH-
endepunkter), paginering (`from_record`/`records_count`), saldo (`GET /v1/accounts/{account_id}`),
webhook-konvolutt (`event`/`type`-skille, `authorization_release` lagt til). `BUSINESS_AUTH_SIGNING_
MATERIAL=PRIMARY_SOURCE_PUBLIC_DOC_GAP` løst med injiserbar `WallesterBusinessJwtSigner` (aldri
gjettet nøkkelopphav). Fail-safe utvidet: ukjent providerstatus/-type lagres `"unknown"` (migrasjon 043
CHECK-constraints utvidet), ALDRI stille "approved"/"purchase" - rettet i BÅDE transport- og
webhook-ingestion-laget. §10 reklassifisert `UNVERIFIED_PRODUCT_ENTITLEMENT` →
`NOT_APPLICABLE_TO_SELECTED_WALLESTER_BUSINESS_API`. Full detalj: D-114 i DECISIONS_AND_ASSUMPTIONS.md.

**Terminalflagg:** `UA6_COMPLETE=false` (siste store kapabilitets-slice bygget - gjenstår dedikert
UA-6-closeout + konsolidert credential-fase). `WALLESTER_LIVE_VERIFIED=false`,
`WALLESTER_LIVE_GATE=PENDING_CREDENTIALS`, `WALLESTER_CREDENTIAL_SETUP_DEFERRED=true`.
`Q26_FULL_TRUTH_PROMOTION_IMPLEMENTED=false` UENDRET.
Full detalj: D-112/D-113/D-114 i DECISIONS_AND_ASSUMPTIONS.md.

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

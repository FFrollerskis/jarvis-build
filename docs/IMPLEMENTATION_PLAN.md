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
migrasjonsplan til alltid-på node hvis tallene tilsier det, runbooks for alle Tier 1-tjenester.

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
| Sandbox | Docker på WSL2; kastbar container per jobb | Kravet i masterplanen; kjører på eksisterende PC (K-06 følges opp) |
| CI | GitHub Actions: lint, typecheck, test, gitleaks, policytester, minne-eval | Alle porter automatiseres |
| Mobil | Swift/SwiftUI + watchOS (fase 8) | Apple-økosystem er kravet (A-05) |

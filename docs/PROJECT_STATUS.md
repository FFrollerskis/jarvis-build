# Jarvis – prosjektstatus

**Oppdatert:** 2026-08-13 · **Branch:** `claude/fase-6-isolated-workers`

## Aktiv fase og oppgave

**Fase 7 – Første integrasjoner: under implementering.** Fase 6 – **FULLFØRT** (arkitektkontroll +
Tobias 2026-08-13, HEAD `fc20cb6` + D-32-lukkecommit). Fase 6-akseptanse endelig: lokalt isolert
worker-system **PASS** · Docker-containerisolasjon **PASS BY EXPLICIT D-32 DEFERMENT** · lokal
kodejobb/branch/test/commit **PASS** · ekte GitHub PR-flyt **PASS BY EXPLICIT D-32 DEFERMENT** ·
human merge-gate i arkitektur **PASS** · faktisk GitHub branch protection **PASS BY EXPLICIT D-32
DEFERMENT** · øvrige kriterier **PASS**.
**Inntil D-32 er lukket: workers er utviklings-/testklare, ikke produksjonsverifiserte autonome workers.**

## Åpne bindende porter (ingen kan stilltiende waives)

| Port | Innhold | Trigges |
|---|---|---|
| **D-27** | Langfuse-runtime (7 steg) | Første Docker-miljø |
| **D-28** | pgvector/HNSW + eval-/RLS-regresjon + ytelse | Første Docker-miljø |
| **D-30** | Norsk voice-providerbenchmark (≥100 prøver) + STOP/GO | Ekte voice-kandidater + prøver; før bred utrulling |
| **D-32** | Worker-container (21 punkter) + ekte GitHub-gate | Første miljø med Docker + autentisert GitHub |

## Fase 6 – implementert (2026-08-13)

- **Durable worker:** lease/reclaim via ny `claim_next_task(worker, lease)` (smal SECURITY DEFINER,
  migrasjon 009), checkpoints + resume, retries (requeue til max_attempts), worker-guard mot stale
  overskriving, kontrollert kansellering (pending/running/ferdig/dobbel), `artifacts`-tabell m/RLS.
- **Delegeringskontrakt håndhevet:** `TaskService.submit` validerer full JobContract; avviser
  ugyldig kontrakt, tenant-mismatch og **strukturelt: untrusted jobb med privat minne + utgående
  nettverk** (prompt-injection-eksfiltrasjonsvern). `JobMemoryAccessor` begrenser jobber til
  kontraktens spaces.
- **Sandbox bak adapter:** `ProcessSandboxRunner` (kastbar arbeidskatalog, REN env uten arvede
  secrets) verifisert; `DockerSandboxRunner`-skall — **containerisolasjon UNVERIFIED uten Docker**
  (fasekrav; verifiseres med Docker-miljøet).
- **Kodejobb:** clone → jobb-branch → agentendring (`CodingAgentAdapter`: skriptet verifisert;
  Claude Code-headless-skall UNVERIFIED) → tester → commit → push av KUN jobb-branch (beskyttede
  brancher nektes i runner + klasse C-mandat kreves) → artefakter (patch/testlogg/PR-forslag).
  Bevist mot ekte lokalt bare-git-repo; **GitHub-PR/branch-protection UNVERIFIED** (ingen API).
- **Sikkerhet bevist i tester:** kill switch stopper delegerte verktøykall; klasse D via worker
  krever fortsatt godkjenning; delegert modellbruk går via Model Gateway (kost på `task_id`,
  hardgrense håndhevet i jobb); retry dobler aldri ekstern handling (idempotens).
- **D-31:** Postgres-køen beholdes; Trigger.dev/Hatchet ikke innført (evaluering dokumentert).
- **96/96 tester grønne** (15 nye fase 6-tester; full fase 1–5-regresjon inkl. voice).

### Fase 6-akseptanse

1. Jobb overlever frakobling, stoppes og gjenopptas: **PASS** (tilstand i PG; checkpoint-resume;
   lease-reclaim; kanselleringsmatrise) · 2. Kodejobb isolert m/branch+tester+artefakter: **PASS**
   (lokal git; PR-forslag som artefakt — ekte GitHub-PR **UNVERIFIED**) · 3. Ingen produksjonsmerge
   uten menneskelig gate: **PASS lokalt** (main urørt, runner+policy nekter; GitHub branch
   protection må slås på av Tobias og er **UNVERIFIED** herfra) · 4. Ugyldig kontrakt avvises: **PASS**.

---

## Arkiv: Fase 5 – Voice Gateway vertikal prototype: FULLFØRT (arkitektkontroll + Tobias 2026-08-13).
Akseptansekriterier: (1) barge-in ≤250 ms **PASS** · (2) pipeline median/P95 **PASS** for
kontrollerte adaptere; ekte-provider-delen **PASS BY EXPLICIT D-30 DEFERMENT** · (3) talekommando
uten stor LLM **PASS** · (4) failover uten doble handlinger **PASS** · (5) norsk benchmark +
stop/go **PASS BY EXPLICIT D-30 DEFERMENT**.

> **Produksjonsbegrensning:** Inntil D-30 er lukket er Voice Gateway en **vertikal prototype /
> utviklings- og testklar** – IKKE en produksjonsverifisert voice-stack.

Fase 0 (`7e31f4a`) · fase 1 (`9e43531`) · fase 2 (`0c74da0`) · fase 3 (`d5a2583`, D-27) ·
fase 4 (`d66945d`, D-28) – alle godkjent.

## Åpne fremtidige verifikasjonsporter (bindende, kan ikke stille waives)

| Port | Innhold | Trigges |
|---|---|---|
| **D-27** | Langfuse-runtime-verifikasjon (7 steg: trace synlig m/korrelasjon+kostnad, kryssjekk mot cost_events) | Første Docker-miljø, før miljøet godkjennes |
| **D-28** | pgvector/HNSW-migrasjon + eval-/RLS-/bitemporal regresjon + ytelsesmåling | Første Docker-miljø, sammen med D-27 |
| **D-30** | Norsk providerbenchmark (≥100 prøver, alle kategorier) + ekte latens/barge-in-retest + eksplisitt STOP/GO | Når STT/TTS-kandidater + lydprøver finnes; senest før bred utrulling (mobil/Watch/satellitter/bil) |

## Fase 5 – implementerte komponenter

- **`apps/voice-gateway` (egen prosess, D-29 WS-transport):** full-duplex sesjonsmotor
  (lytter/tenker/snakker), streaming lydrammer, deterministisk energi-VAD med end-of-turn,
  **ekte barge-in** (tale under avspilling kansellerer TTS umiddelbart), latenstidsstempler per
  delstrekning, utterance-journal (idempotente turer ved failover), AEC/støy-hooks (passthrough i
  pilot). Gateway snakker KUN med Core via `/chat` – ingen samtale/minne/policy i gatewayen.
- **SpeechAdapter-kontrakter:** STT (MarkerStt-test, OpenAI, lokal whisper-skall) og TTS
  (FakeTts-test m/sanntidstakt, OpenAI, lokal piper-skall). Leverandørvalg låses IKKE – det hører
  til stop/go-porten.
- **Benchmark-harness** (`benchmark.ts`): WER (testet) + latens-P50/P95 per kategori; håndhever
  ≥100-prøver-kravet. Instruks: [VOICE_BENCHMARK.md](VOICE_BENCHMARK.md).
- **Tale-DPIA** fullført for pilotens omfang: [security/DPIA_VOICE.md](security/DPIA_VOICE.md)
  (ingen lyd forlater maskinen i pilot; leverandør-gate dokumentert).
- Ingen databaseendringer; ingen HA; ingen ny minnestack.

## Fase 5 – målte resultater (2026-08-13, testadaptere)

- **Barge-in:** TTS kansellert ≤250 ms etter ren tale – målt i sanntid gjennom reell WS-kjede: PASS.
- **Latens (8 turer, hele kjeden lyd→VAD→STT→Core→TTS-første-ramme→ferdig):**
  **median 667 ms, P95 694 ms**; alle delmålinger (første partial, end-of-turn, Core-svar, første
  TTS-ramme) registrert per tur. Providerlatens er IKKE inkludert (testadaptere) – ærlig UNVERIFIED
  til benchmark kjøres.
- **Sesjonskontinuitet:** tekstsesjon gjenopptatt av talekanal med samme `session_id` (og motsatt vei
  via samme mekanisme): PASS.
- **Fast bane via tale:** «status» rutes deterministisk, `routed=fast`, ingen modellkall: PASS.
- **Failover:** fullført utterance replayet etter «restart» (delt journal) → avvist, nøyaktig 1 jobb
  i databasen: PASS. Lyd før sesjonsstart avvises kontrollert.
- **81/81 tester grønne** (9 filer; fase 1–4-regresjon uendret grønn), også under Node 22.14.0.

## Fase 5 – avvik

- **Ekte provider-verifikasjon er utsatt via D-30** (bindende port, se tabellen over) – harness +
  instruks levert; ingen mål er senket. Reelle STT/TTS-adaptere er skrevet/typesjekket men ukjørte.
- **HA Assist-reservevei:** dokumentert i VOICE_ARCHITECTURE §8; kan ikke testes uten HA-instans –
  testes i fase 9.
- Core-kallet er JSON (ikke SSE-token-streaming inn i TTS) i piloten; TTS-strømmen og STT-partials
  er reelle strømmer. Token→TTS-streaming er en kjent forbedring før produksjonstale.
- Utterance-journal er in-memory bak injiserbart grensesnitt; persistent lager når gatewayen får
  delt tilstand.

## D-27 / D-28

Begge åpne og bindende (Docker ble ikke etablert i fase 5 – ikke påkrevd). Kjøres ved første
Docker-miljø: Langfuse-verifikasjon (D-27, 7 steg) + pgvector/HNSW-migrasjon med eval-regresjon og
ytelsesmåling (D-28).

## Blokkeringer

1. CI-resultat kan ikke verifiseres herfra (`gh` mangler).
2. Fase 6 krever eksplisitt godkjenning fra Tobias.

## Neste fase

**Fase 6 – Oppgaver og isolerte workers** (durable workflow-evaluering, sandbox per jobb,
agentprofiler, PR-flyt). Planlagt branch: `claude/fase-6-isolated-workers`. Kun etter godkjenning.

---

## Arkiv

Fase 1 `9e43531` · Fase 2 `0c74da0` · Fase 3 `d5a2583` (D-27-deferment) · Fase 4 `d66945d`
(72 tester, D-28, RLS tenant+space, eval 60 spørringer).

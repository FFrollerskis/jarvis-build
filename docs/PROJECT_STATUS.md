# Jarvis – prosjektstatus

**Oppdatert:** 2026-08-13 · **Branch:** `claude/fase-6-isolated-workers`

## Aktiv fase og oppgave

**Fase 10 – Drift: implementert (watchdog, backup/restore malt, kostnadsrapport, Tier 1-runbooks; 121/121 tester). UNVERIFIED: ekstern uptime, off-site backup, 30-90-dagers maling, NAS-migrasjon (krever driftstid/runtime).**
**Fase 9 – Home Assistant, hus og steder: implementert (uten live HA - UNVERIFIED); fase 8 funksjonelt implementert med D-36-runtime-port aapen.**

## Fase 9 - resultater (2026-08-13)

- HA-verktoy i Tool Gateway (tilstand=A, lys/klima=B, laas/alarm=D m/rollback/scopes/rate limit); stedsbevisst fast-router («skru paa lyset her» - rom fra identitetskonteksten); klasse D via talekanal bevist (DENY uten godkjenning / ALLOW / replay-DENY); 5 nye tester (116/116). UNVERIFIED: live HA-instans, fysisk skybrudd-/romfeiltest, HA Assist-fallback (krever HA-miljoe).

**Fase 8 – Mobil, Watch og kontinuitet: backend-fundament implementert; native klientlag BLOKKERT
på Apple-verktøykjede.**

## Fase 8 – resultater (2026-08-13)

- **Bygget og bevist (5 nye tester, 111/111 totalt):** DeviceService (server-side registrering av
  enhetsnøkler — klient-ID alene stoles aldri på); `PgDeviceRegistry` koblet inn i Policy Gateway i
  kjørende app (klasse D verifiseres mot REGISTRERT nøkkel i databasen: registrert Watch → ALLOW,
  uregistrert → DENY, feil nøkkel → DENY, tenant-RLS på nøkler); challenge-respons enhetsauth
  (engangs, replay avvist); mobil-kanal gjenopptar samme sesjon som web; push bak adapter
  (FakePush verifisert; APNs-skall feiler ærlig som uverifisert).
- **BLOKKERT/UNVERIFIED — krever beslutning/ressurser fra Tobias:** native iPhone-/watchOS-appene
  (Swift/SwiftUI, App Intents, Live Activity, Secure Enclave-nøkler, TestFlight, push innen
  sekunder, samtale på låst telefon) kan ikke bygges i dette Windows-miljøet: **krever Mac med
  Xcode + Apple Developer-konto.** Plan-akseptanse 1–3 for fysiske enheter er dermed UNVERIFIED;
  backend-kontraktene de trenger er klare og testet.
- Fase 8 kan ikke lukkes før klientlaget er bygget i Apple-miljø (eller Tobias eksplisitt
  omdefinerer/utsetter fasen).
**Fase 7 – FULLFØRT** (arkitektkontroll + Tobias 2026-08-13). Endelig akseptanse: (1)
scopes/audit/rate limit/rollback/injection **PASS**, live providerdel **PASS BY D-35 DEFERMENT** ·
(2) e-post sender aldri uten approval **PASS** · (3) full sporing/proveniens **PASS** · (4) vault:
arkitektur/valg (D-33 Infisical) **PASS**, faktisk runtime **PASS BY D-35 DEFERMENT**.
Q-05 lukket (D-33: Infisical) · Q-07 lukket (D-34: Gmail først, konto som konfig).
Inntil D-35: integrasjonene er arkitektur-/utviklingsverifiserte, ikke produksjonsverifiserte.

## Fase 7 – resultater (2026-08-13)

- **Tool Gateway** (`modules/tool-gateway`): maskinlesbart register (skjema, klasse, scopes,
  reversibilitet/rollback, idempotens, timeout, rate limit, credential-ref, output-tillit);
  pipeline Identity → Policy → rate limit → idempotensdedupe → adapter → audit; migrasjon 010
  (`tool_executions` m/RLS). 9 førstebølge-verktøy registrert (GitHub les/PR, kalender les/opprett,
  e-post les/**send=klasse D**, Drive, Telegram, Vercel).
- **Ingestion:** ekstern kilde → karantene via fase 4-MemoryWriter (untrusted; aldri autoritativt
  uten policy-promotering); injection-e-post kan ikke nå retrieval eller utløse utsending.
- **Secrets:** `SecretProvider`-adapter (env/SOPS-impl nå; Infisical-skall). **Akseptanse 4
  (vault) UNVERIFIED/blokkert: Q-05 (Infisical vs. OpenBao) er ÅPEN og begge krever Docker.**
  Q-07 (Gmail vs. Outlook) ÅPEN — adaptere er leverandørnøytrale.
- **10 nye tester (106/106 totalt):** metadata-komplett register; audit med credential-REF (aldri
  verdi — verifisert i alle audit-rader); email.send DENY uten godkjenning / ALLOW med / replay-DENY;
  injection-karantene; idempotent retry (samme external_id, ingen ny ekstern handling);
  cross-tenant RLS på tool_executions; jobb-scoping (`allowed_tools`); revoked credential →
  kontrollert feil; kill switch; rate limit; mandatløs klasse C → DENY.
- **UNVERIFIED (miljø):** reelle API-kall mot GitHub/Google/Telegram/Vercel (ingen
  OAuth-/API-credentials — transportskall klare); vault-utrulling (Docker + Q-05).
- **Akseptanse:** (1) scopes/audit/rate limit/rollback/injection-test per verktøy: **PASS**
  (mot kontrollerte transporter; live API UNVERIFIED) · (2) e-post utløser aldri utgående handling
  uten godkjenningssteg: **PASS** · (3) sporing til person/jobb/policy/credential: **PASS** ·
  (4) secrets i vault: **UNVERIFIED — krever Q-05-beslutning + Docker-miljø** (D-16-strategien med
  SOPS/env og null nøkler i repo er fulgt). Fase 6 – **FULLFØRT** (arkitektkontroll +
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
| **D-36** | Apple-runtime (Xcode-build, fysisk iPhone/Watch, kontinuitet, klasse D fra klokke, APNs) | Mac mini + Apple-credentials (2026-08-14) |
| **D-35** | Infisical-runtime (10 steg) + live OAuth/Gmail/Calendar/GitHub/Drive/Telegram/Vercel per integrasjon | Docker + credentials; Infisical-delen trigges av første Docker-miljø |

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

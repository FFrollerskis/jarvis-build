# Jarvis – prosjektstatus

**Oppdatert:** 2026-08-13 · **Branch:** `claude/fase-5-voice-prototype`

## Aktiv fase og oppgave

**Fase 5 – Voice Gateway vertikal prototype: FULLFØRT** (arkitektkontroll + Tobias 2026-08-13).
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

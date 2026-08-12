# Jarvis – prosjektstatus

**Oppdatert:** 2026-08-13 · **Branch:** `claude/fase-4-hybrid-memory`

## Aktiv fase og oppgave

**Fase 4 – Hybridminne v1: implementert, venter på ekstern arkitektkontroll og Tobias sin godkjenning.**
Fase 0 fullført (`7e31f4a`); fase 1 godkjent (`9e43531`); fase 2 godkjent (`0c74da0`);
fase 3 FULLFØRT/godkjent (`d5a2583`, akseptanse 2 via D-27-deferment).

## Fase 4 – implementerte komponenter

- **Migrasjon 008:** `memory_sources`, `memory_items` (bitemporal: observed/valid_from/valid_to,
  sensitivitet, tillit, konfidens, versjon, status, konfliktflagg, FTS-kolonne norsk + GIN),
  `memory_versions` (append-only m/trigger), `entities`, `relations`, `memory_item_entities`,
  `summaries`, `embeddings` (portabel `real[]`, D-28), `decisions`, `commitments`, `deadlines`.
- **RLS på tenant OG space i databasen:** space-policy er `AS RESTRICTIVE` (AND-es med
  tenant-policyen); kontekst via `jarvis.memory_spaces`; default deny uten kontekst.
- **`modules/memory`:** MemoryWriter (ADD/UPDATE/INVALIDATE/NOOP, dedup på subjekt,
  konfliktversjonering, karantene for untrusted, promotering KUN via Policy Gateway, audit i samme
  transaksjon); MemoryRetriever/Context Builder v2 (FTS + vektor m/relevansterskel + 1-hopps
  relasjonsutvidelse + tidsfilter m/versjonssøk + reranking + kildeangivelse); SummaryService
  (dagssammendrag); MemoryExporter (menneskelesbar mappeeksport per MEMORY_ARCHITECTURE §8);
  adaptere: `EmbeddingProvider` (LocalHash deterministisk + OpenAI-klar), `ExtractionAdapter`
  (regelbasert nå, LLM-uttrekk kobles på samme grensesnitt).
- **Samtaleintegrasjon:** Conversation Engine beriker systemprompten med minne + kilde fra KUN
  gjeldende space; health kombineres aldri med andre spaces (håndhevet i kode og test).

## Fase 4 – testresultater (2026-08-13)

- **72/72 tester grønne** (18 nye minnetester + full fase 1–3-regresjon), mot ekte embedded
  PostgreSQL 16.14. Også grønt under Node 22.14.0.
- **Eval-sett: 60 spørringer** – 30 fakta m/kildeangivelse, 5 tidsspørsmål (valid_from/valid_to +
  versjonssøk), 5 motstrid (begge versjoner synlige), 20 tilgangsspørsmål (health/guest/kryss-tenant
  = null lekkasje). Kjørbar i CI som del av testsuiten.
- **Ytelse:** hybridsøk P95 < 300 ms målt lokalt (20 søk over 250+ items).
- **Sikkerhetsfunn fikset under testing (med regresjonstest):** delt kilde-ID på tvers av tenants
  gjorde at RLS skjulte kilderaden og JOIN mistet items → kilde-ID-er er nå tenant-skopet.

## Fase 4 – avvik

- **D-28:** embeddings som `real[]` + SQL-cosine (pgvector mangler i embedded test-PG); bindende
  pgvector/HNSW-port ved første Docker-miljø, sammen med D-27 (Langfuse).
- LLM-assistert uttrekk er bak adapter men kjører regelbasert i denne fasen (billig-modell-uttrekk
  kobles på når modellnøkler er i bruk); ingen arkitekturendring kreves.
- Docker fortsatt fraværende; `docker compose config` uverifisert (uendret).

## D-27-status

Åpen og bindende. Docker ble ikke etablert i fase 4 (ikke påkrevd av fasen); Langfuse-porten +
pgvector-porten (D-28) kjøres ved første Docker-miljø før det godkjennes.

## Blokkeringer

1. **CI-resultat kan ikke verifiseres herfra** (`gh` mangler).
2. **Fase 5 krever eksplisitt godkjenning** etter ekstern arkitektkontroll av fase 4.

## Neste fase

**Fase 5 – Voice Gateway vertikal prototype** (timebox 2×2 uker, norsk benchmark ≥100 prøver,
tale-DPIA, stop/go-port). Planlagt branch: `claude/fase-5-voice-prototype`. Starter kun etter godkjenning.

---

## Arkiv

- **Fase 1** godkjent `9e43531` · **Fase 2** godkjent `0c74da0` · **Fase 3** FULLFØRT `d5a2583`
  (akseptanse 2 = PASS by D-27-deferment; 54 tester, gitleaks clean, Node 22 verifisert).

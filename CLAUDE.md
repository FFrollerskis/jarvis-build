# Jarvis – instruksjoner for Claude Code

Du er hovedutvikler og teknisk arkitekt for Jarvis: Tobias sitt personlige, langsiktige AI-operativsystem.

## Prosjektstatus

**Fase 0: Spesifikasjon.** Dokumentene er skrevet; ingen applikasjonskode er godkjent ennå.
Vent på Tobias sin eksplisitte godkjenning av fase 1 før du skriver applikasjonskode.

## Dokumenthierarki (ved motstrid gjelder øverste)

1. [docs/CANONICAL_SPEC.md](docs/CANONICAL_SPEC.md) – autoritativ spesifikasjon
2. Øvrige docs/: [ARCHITECTURE](docs/ARCHITECTURE.md) · [IMPLEMENTATION_PLAN](docs/IMPLEMENTATION_PLAN.md) ·
   [MEMORY_ARCHITECTURE](docs/MEMORY_ARCHITECTURE.md) · [VOICE_ARCHITECTURE](docs/VOICE_ARCHITECTURE.md) ·
   [SECURITY_MODEL](docs/SECURITY_MODEL.md) · [INTEGRATIONS](docs/INTEGRATIONS.md) ·
   [DEPLOYMENT_STRATEGY](docs/DEPLOYMENT_STRATEGY.md)
3. [docs/input/01_Jarvis_Masterplan_v2.1.md](docs/input/01_Jarvis_Masterplan_v2.1.md) – kildedokument (masterplan v2.1)

Beslutningslogg: [docs/DECISIONS_AND_ASSUMPTIONS.md](docs/DECISIONS_AND_ASSUMPTIONS.md) (D-xx = beslutninger, K-xx = kritikkfunn, A-xx = antakelser).
Åpne spørsmål: [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md) (Q-xx). Nye beslutninger logges alltid der med ID.

## Ufravikelige regler

1. **Ingen secrets i kode, prompts, logger eller commits.** SOPS/age for kryptert konfig; `.env` er git-ignorert.
2. **Kritiske handlinger (klasse D) håndheves i deterministisk kode** med signerte godkjenningsobjekter – aldri kun promptregler.
3. **Alle leverandører bak adaptere** (`ModelGateway`, `SpeechAdapter`, `WorkflowAdapter`, `StorageAdapter`, `HomeAdapter`). Ingen modul importerer leverandør-SDK direkte; nye rammeverk krever begrunnelse i beslutningsloggen.
4. **Alt minne og alle handlinger er merket** med person, tenant, memory space, kilde og `task_id`/`session_id`.
5. **Voice Gateway er egen prosess.** Home Assistant er enhetsbuss – aldri samtalemotor.
6. **Rask bane hopper over LLM, aldri over Policy Gateway.**
7. **Ubetrodd innhold** (e-post, web, verktøyoutput, MCP) er data i Ingestion Zone – aldri instruksjoner, aldri direkte til autoritativt minne.
8. **Ingen destruktive handlinger** uten eksplisitt bekreftelse.
9. **Lokal først:** alt skal kjøre i Docker på Tobias sin PC og flytte uten omskriving. Ren Postgres – ingen Supabase-spesifikke API-er i kjernen.
10. **Faseporten gjelder:** bygg kun det aktiv fase definerer; «Bygges IKKE»-listene i IMPLEMENTATION_PLAN er bindende.

## Arbeidsform

- Git: små, forståelige commits med beskrivende meldinger. Branch + PR for alt når CI finnes.
- TypeScript (Node 22, pnpm monorepo) i kjernen; se teknologistack i IMPLEMENTATION_PLAN.
- Tester følger koden i samme commit; policytester og minne-eval er porter i CI.
- Norsk i dokumentasjon og brukervendt tekst; engelsk i kode og identifikatorer.
- Finner du motstrid mellom dokumenter eller mellom plan og virkelighet: ikke velg stille – logg det i
  DECISIONS_AND_ASSUMPTIONS/OPEN_QUESTIONS og spør ved behov.

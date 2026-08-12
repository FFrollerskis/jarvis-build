# Jarvis – prosjektstatus

**Oppdatert:** 2026-08-12 · **Branch:** `claude/fase-3-core-text-mvp`

## Aktiv fase og oppgave

**Fase 3 – Jarvis Core og tekst-MVP: implementert; akseptanse 1/3/4/5 PASS, akseptanse 2 UNVERIFIED
(Langfuse-visning, se egen seksjon). Venter på Tobias sin beslutning om lukking/utsettelse.**
Fase 0 fullført (`7e31f4a`); fase 1 godkjent (`9e43531`); fase 2 godkjent (`0c74da0`).

## Fase 3 – implementerte komponenter

- **Conversation Engine** (`apps/api`): rask bane først, deretter modellbane; SSE-streaming;
  alle svar persisteres i sesjonshistorikk.
- **Fast Router v1** (`modules/core`): deterministisk intentmatch (status, opprett/avbryt jobb,
  jobbstatus, hjelp) – kjente kommandoer bruker aldri LLM, sporet i trace.
- **Model Gateway** (`modules/model-gateway`) + **provider-adaptere** (`packages/provider-adapters`):
  Anthropic, OpenAI, Ollama (lokal) og skriptet testadapter bak felles grensesnitt; ordnet fallback;
  rate limit; kostnad per kall → `cost_events` med `session_id`/`task_id`; **håndhevede
  budsjettgrenser 1 000/2 000/3 000 kr/mnd** (varsel / krever godkjenning / hardgrense) i kode.
- **Task Service + WorkflowAdapter** (`modules/tasks`): Postgres-kø (pg-boss-klasse) med claiming via
  SECURITY DEFINER-funksjon (D-26, aldri RLS-bypass i app-rollen); in-process worker; policykontroll
  (klasse A/B) på alle jobb-operasjoner; audit.
- **Context Builder v1** (`modules/core`): sesjonshistorikk + åpne jobber under tenant-RLS.
- **Policy Gateway async + persistent replay-vern:** `PgApprovalStore` (approvals-tabellen) er nå
  koblet inn; fail-closed ved lagerfeil; feilede kontroller brenner ikke nonce; samtidighet bevist.
- **Webchat** (`apps/web`): statisk side med SSE-streaming, rute-/jobbvisning (D-24).
- **Observability:** `TraceSink`-adapter med JSONL-sink (lokal) og Langfuse-sink (klar, se avvik);
  alle modellkall og fast-ruter spores med kostnad og `session_id`/`task_id`.
- Migrasjoner 006 (kø-felter) og 007 (claim-funksjon).

## Fase 3 – testresultater (2026-08-12)

- **54/54 tester grønne**: kontrakter 9, policy 18 (inkl. ny fail-closed), datafundament 13 (fase
  2-regresjon), fast-router 2, health 2, **fase 3 e2e 10** (ekte HTTP-server mot ekte embedded
  PostgreSQL 16.14 – ingen mocks).
- `pnpm lint` og `pnpm typecheck` (7/7 pakker) grønne.
- **API kjørt reelt:** `/health` 200, webchat-side 200, `/chat` ærlig 503 uten DB-konfig.
- PgApprovalStore-kontrollpunktet: alle 8 krav bevist (gyldig→ALLOW, første nonce→ALLOW,
  replay→DENY, samtidighet→nøyaktig én ALLOW, DB-feil→DENY, rollback åpner ikke replay,
  feil action/parameter/signatur/utløp/enhet brenner ikke nonce, atomisk forbruk før handling).

## Fase 3 – akseptansekriterium 2: UNVERIFIED (Langfuse-delen)

Planens eksakte tekst (IMPLEMENTATION_PLAN.md, akseptansekriterium 2, fase 3):
«Hvert modellkall har kostnad knyttet til `task_id`/`session_id`, synlig i Langfuse.»
«Synlig i Langfuse» er dermed en obligatorisk del av kriteriet. Status:

- **Verifisert:** kostnad per modellkall persisteres i Postgres (`cost_events` med
  `session_id`/`task_id`, bevist med SQL i e2e-test); hvert kall produserer trace-span med samme
  korrelasjon og kostnad (bevist mot `TraceSink` i e2e-test).
- **Implementert, ikke verifisert:** `LangfuseTraceSink` (ingestion-API, basic auth fra miljø) er
  skrevet og typesjekket, men har aldri sendt til en kjørende Langfuse.
- **Mangler for fullt bevis:** en kjørende selvhostet Langfuse-instans (krever Docker – finnes ikke
  på dev-PC-en) + visuell/API-kontroll av at spans med kostnad vises der.
- **Konsekvens:** Akseptansekriterium 2 er **UNVERIFIED** (ikke PASS) og fase 3 kan ikke lukkes
  ubetinget. Planen gir ingen eksplisitt hjemmel for utsettelse; flytting av Langfuse-visningen til
  driftsverifikasjon i første Docker-miljø (NAS-oppsett eller Docker-installasjon) krever eksplisitt
  beslutning fra Tobias, som i så fall logges som D-27 i beslutningsloggen.

## Fase 3 – øvrige avvik
- **Reelle Anthropic/OpenAI-kall uverifisert:** ingen API-nøkler i miljøet (med vilje). Adaptere er
  skrevet og typesjekket; e2e bruker skriptet adapter. Verifiseres når Tobias legger nøkler i `.env`.
- **Docker fortsatt fraværende:** `docker compose config` uverifisert (uendret fra fase 2).
- Runtime byttet til Node `--experimental-transform-types` med `.ts`-relative imports (D-25) etter at
  reell kjøring avdekket to feil vitest skjulte. Ingen build-steg ennå.
- API-et har ingen egen HTTP-autentisering (localhost dev): enhetsautentisering kommer med kanalene
  (fase 8-ambisjon); dokumentert i server-koden.

## Blokkeringer

1. **CI-resultat kan ikke verifiseres herfra** (`gh` mangler).
2. **Fase 4 krever eksplisitt godkjenning** etter ekstern arkitektkontroll av fase 3.

## Neste fase

**Fase 4 – Hybridminne v1** (rå eventlogg→strukturert→fulltekst→pgvector→relasjoner→sammendrag→
karantene→eksport→eval). Planlagt branch: `claude/fase-4-hybrid-memory`. Starter kun etter godkjenning.

---

## Arkiv

- **Fase 1** godkjent på `9e43531` (kjørbart sikkerhetsfundament; 28 tester; gitleaks clean).
- **Fase 2** godkjent på `0c74da0` (datafundament med RLS; 41 tester; PgApprovalStore levert).

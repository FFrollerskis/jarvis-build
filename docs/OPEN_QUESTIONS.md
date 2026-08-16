# Jarvis – åpne spørsmål

**Status:** Utkast v1.0. Spørsmål lukkes ved å flytte svaret til
[DECISIONS_AND_ASSUMPTIONS.md](DECISIONS_AND_ASSUMPTIONS.md) med beslutnings-ID.

## Lukkede spørsmål

| ID | Utfall |
|---|---|
| Q-01 | **Lukket 2026-08-12** → D-18: Masterplan v2.1 behandles som eneste tilgjengelige kildedokument; nye eksplisitte Tobias-beslutninger kan overstyre når de dokumenteres i CANONICAL_SPEC/DECISIONS |
| Q-02 | **Lukket 2026-08-12** → D-18–D-23: A-01/A-02/A-04/A-05/A-06 bekreftet; A-03 erstattet av ny maskinvareplan (D-20) |
| Q-18 | **Lukket 2026-08-14 (D-30 host failure fix)** → ToolGateway sin `tool_executions`-dedupe rammet A-klasse READs på tvers av brukerturer i samme session (§21/§19-formålet var kun C/D-mutasjoner). Fikset i `modules/tool-gateway/src/gateway.ts` (`dedupeApplies = capability_class !== "A"`): A-klasse reads utfører nå alltid friskt per brukertur; C/D database-dedupe uendret. In-memory beskyttelse mot at MODELLEN ber om samme kall flere ganger i ÉN samtaletur (ModelGateway.completeWithTools sin `executed`-cache) var ALDRI berørt av bugen og er uendret. Bevist: `modules/tool-gateway/test/q18-read-dedupe.test.ts` (fersk utførelse tur 2 + write-dedupe uendret) og `modules/tool-gateway/test/same-turn-tool-dedupe.test.ts` (maks 1 faktisk utførelse per tur, uansett om modellen ber om samme kall i samme eller påfølgende runde). |
| Q-21 | **Lukket 2026-08-15 (host-bevist, run_id `778bb87d`)** → D-38/D-39: systembredt DB admin/runtime-rolle-gap (api/worker/migrate kjørte som Postgres-superbruker, RLS aldri håndhevet til tross for korrekte policyer) fikset permanent og verifisert LIVE mot ekte Postgres/pgvector - `jarvis_runtime` (NOSUPERUSER/NOBYPASSRLS/LOGIN/medlem av `jarvis_app`), `tenant_isolation=PASS`, `memory_space_isolation=PASS`. Samtidig host-verifiserte dette UA-2 P0 fullt ut (D-39) - `symlink_escape=SKIPPED_HOST_PERMISSION` er eksplisitt dokumentert som IKKE et live-PASS (suite-bevist, ikke host-bevist). |
| Q-20 | **Lukket 2026-08-16 (host-bevist på ekte Windows/Docker-host, run_id `eaabe2b1`)** → D-40: teknisk data-erasure-foundation (`@jarvis/erasure`) - hard delete av original + avledet innhold, FTS/vector/hybrid/memory-retrieval=0 etter purge, resurrection-suppresjon bevist (`created=0`/`suppressed=1`), idempotens bevist, tenant/space-isolasjon urørt, erasure-kvittering uten slettet payload, full sentinel-scan uten funn - alle `q20_*`-felt PASS, `hard_fail=false`. Q-21 sin runtime-rolle-sikkerhet fortsatt PASS i samme kjøring. Tre host-recovery-runder (workspace-bootstrap, Windows pnpm-prosessoppløsning, DEP0190-opprydding) løste kun host-/prosess-hygiene, ingen erasure-/migrasjons-/policy-logikk endret. **Teknisk erasure-foundation - IKKE en juridisk GDPR-compliance-sertifisering.** Fortsatt eksplisitt dokumenterte, ikke purgede stores: `events`/`audit_events`-payload (append-only-blokkert), `tasks`/`tool_executions`-innhold, Langfuse/trace-fil, `person`-scope dekker ikke knowledge-dokumenter. |

## Trenger svar fra Tobias

| ID | Spørsmål | Kontekst | Haster |
|---|---|---|---|
| Q-05 | Vault-preferanse: Infisical (enklere, har sky-opsjon) eller OpenBao (helt åpen, mer drift)? | Vault innføres når flere tjenester trenger delte secrets, senest fase 7 (D-16); valget påvirker ikke fase 1–3 | Før vault innføres (senest fase 7) |
| Q-07 | Hvilken e-post/kalender er primær: Gmail eller Outlook? (tobias@ffskis.com – hvilken plattform ligger den på?) | Styrer fase 7-integrasjonene; begge støttes via adapter, men én bygges først | Innen fase 7 |
| Q-08 | Skal Jarvis ha egen Telegram-bot fra fase 3 (tidlig varslingskanal) eller vente til fase 7? | Telegram er billig å koble tidlig og nyttig for jobbvarsler | Innen fase 3 |

## Avgjøres av måling/prototype (ikke av diskusjon)

| ID | Spørsmål | Avgjøres i | Metode |
|---|---|---|---|
| Q-03 | Hvilken STT/TTS-leverandør (ev. lokal) og hvilken WebRTC-stack (LiveKit vs. alternativ)? Hva hvis ingen når 250 ms/1,5 s-målene fra Norge? | Fase 5 | Norsk benchmark ≥100 prøver + stop/go-port; utfallsrommet inkluderer lokal STT/TTS og justerte mål |
| Q-04 | Egne TS-modelladaptere vs. LiteLLM-proxy som sidecar-container? | Fase 3 | Start med TS-adaptere; bytt hvis adapter-vedlikehold overstiger nytten |
| Q-06 | Er WSL2-basert Docker-isolasjon god nok for Coding Worker på Windows 11 Home, eller trengs full VM? | Fase 6 | Sikkerhetstest av sandbox-grensene med reelle jobber |
| Q-09 | pg-boss-klasse kø vs. Trigger.dev/Hatchet for durable workflows? | Fase 6 | Evaluering med reelle jobbmønstre (checkpoints, resume, observability) |
| Q-10 | Trenger relasjonslaget egen grafdatabase? | Etter fase 4-eval | Flerhopp-spørsmål i minne-evalen; bytt kun ved målt svikt |
| Q-11 | Lokal LLM-økonomi: lønner GPU-server seg? | Fase 10 | 30–90 dagers kostnads-/bruksmåling |
| Q-12 | Satellitt-maskinvare for rom (HA Voice PE, egen build, annet)? | Fase 5/9 | Prototype + benchmark |
| Q-19 | **Ytelsesgjeld, D-30 voice (registrert ved VERIFIED-lukking 2026-08-14, IKKE en korrekthets-blokker).** Host-akseptanse bekreftet D-30 funksjonelt korrekt, men latensen er treg for ønsket realtime-opplevelse: `end_of_speech_to_first_audio_ms` vanligvis ~3,5-6,2s, enkelte turer ~9-12s, streaming-smoke første token ~12,7s. Bevisst IKKE optimalisert i D-30-lukkingen (egen scope). Kandidatårsaker å undersøke: modellvalg/reasoning-overhead, TTS-round-trip per setningschunk (sekvensiell, ikke forhåndsberegnet), nettverk Windows↔Docker↔cloud-provider. Relatert til, men adskilt fra, Q-03 (endelig STT/TTS-leverandørvalg via D-10-benchmark). | Egen hardening/optimaliseringsrunde etter D-30 | Reelle host-latensmålinger over flere turer/providere; profiler hvert ledd (STT/model_ttft/tool/TTS_ttfa) separat før noe endres |

## Parkert (bevisst utsatt)

| ID | Tema | Tidligst |
|---|---|---|
| Q-13 | Bil-integrasjon (CarPlay/bil-API) | Etter fase 8 |
| Q-14 | Apple Health / `health`-space-innhold og lokal modell for helse | Etter fase 8, krever DPIA-utvidelse |
| Q-15 | Flere personer/familie som egne `person_id` med egne spaces | Etter første produksjonsversjon |
| Q-16 | Andre bølge-integrasjoner (CRM/Dennis, Fiken/Folio, telefoni, Slack/Teams) | Etter fase 7 |
| Q-17 | Autonom selvreparasjon via signerte runbooks | Etter fase 10-måling |

# Jarvis – åpne spørsmål

**Status:** Utkast v1.0. Spørsmål lukkes ved å flytte svaret til
[DECISIONS_AND_ASSUMPTIONS.md](DECISIONS_AND_ASSUMPTIONS.md) med beslutnings-ID.

## Lukkede spørsmål

| ID | Utfall |
|---|---|
| Q-01 | **Lukket 2026-08-12** → D-18: Masterplan v2.1 behandles som eneste tilgjengelige kildedokument; nye eksplisitte Tobias-beslutninger kan overstyre når de dokumenteres i CANONICAL_SPEC/DECISIONS |
| Q-02 | **Lukket 2026-08-12** → D-18–D-23: A-01/A-02/A-04/A-05/A-06 bekreftet; A-03 erstattet av ny maskinvareplan (D-20) |
| Q-18 | **Lukket 2026-08-14 (D-30 host failure fix)** → ToolGateway sin `tool_executions`-dedupe rammet A-klasse READs på tvers av brukerturer i samme session (§21/§19-formålet var kun C/D-mutasjoner). Fikset i `modules/tool-gateway/src/gateway.ts` (`dedupeApplies = capability_class !== "A"`): A-klasse reads utfører nå alltid friskt per brukertur; C/D database-dedupe uendret. In-memory beskyttelse mot at MODELLEN ber om samme kall flere ganger i ÉN samtaletur (ModelGateway.completeWithTools sin `executed`-cache) var ALDRI berørt av bugen og er uendret. Bevist: `modules/tool-gateway/test/q18-read-dedupe.test.ts` (fersk utførelse tur 2 + write-dedupe uendret) og `modules/tool-gateway/test/same-turn-tool-dedupe.test.ts` (maks 1 faktisk utførelse per tur, uansett om modellen ber om samme kall i samme eller påfølgende runde). |

## Trenger svar fra Tobias

| ID | Spørsmål | Kontekst | Haster |
|---|---|---|---|
| Q-05 | Vault-preferanse: Infisical (enklere, har sky-opsjon) eller OpenBao (helt åpen, mer drift)? | Vault innføres når flere tjenester trenger delte secrets, senest fase 7 (D-16); valget påvirker ikke fase 1–3 | Før vault innføres (senest fase 7) |
| Q-07 | Hvilken e-post/kalender er primær: Gmail eller Outlook? (tobias@ffskis.com – hvilken plattform ligger den på?) | Styrer fase 7-integrasjonene; begge støttes via adapter, men én bygges først | Innen fase 7 |
| Q-08 | Skal Jarvis ha egen Telegram-bot fra fase 3 (tidlig varslingskanal) eller vente til fase 7? | Telegram er billig å koble tidlig og nyttig for jobbvarsler | Innen fase 3 |
| Q-21 | **Mangler den faktiske lokale Docker-driften en ekte non-bypass runtime-DB-rolle?** (funnet ved UA-2 P0 host-blocker 2026-08-15, se RUNTIME_GATES.md). `jarvis_app` (005_rls.sql) er en `NOLOGIN`-gruppe-rolle - INGEN sted i den faktiske driftsveien (`migrate-main.ts`, `docker-compose.yml`, Dockerfiles) oppretter en ekte `LOGIN`-rolle som er `GRANT`et inn i `jarvis_app`; kun test-oppsett (`beforeAll` i suiten) gjør dette. `.env.example` sin `JARVIS_DB_USER=jarvis_app` kan derfor ikke faktisk logges inn med - noe MÅ stå i Tobias sin reelle `.env` for at systemet i det hele tatt skal koble til (mest sannsynlig `JARVIS_DB_USER=postgres`, samme superbruker som `JARVIS_DB_ADMIN_USER`). Hvis så: RLS er ALDRI håndhevet for api/worker/migrate i den faktiske lokale driften - en superbruker bypasser RLS uansett policy-korrekthet. UA-2 P0-harnesset (`ua2-p0-live.ts`) rapporterer nå dette eksplisitt (`configured_app_role`/`_superuser`/`_bypassrls`) og bruker en dedikert non-bypass rolle KUN for isolasjons-BEVISET (bootstrappet av harnesset selv via `JARVIS_DB_ADMIN_USER`) - men selve produksjonsdrifts-gapet er IKKE fikset noe sted (docker-compose/migrate-main.ts er bevisst urørt, utenfor denne BO-ens scope). Trenger Tobias sin bekreftelse av hva faktisk `JARVIS_DB_USER` er satt til på hosten, og en beslutning om en ekte login-rolle skal bootstrappes i selve driftspipelinen (egen migrasjon, f.eks. `018_app_login_role.sql` + docker-compose/`.env`-oppdatering) - dette er en systembred endring (påvirker `memory_items` osv., ikke bare UA-2), IKKE noe som bør gjøres stille inni en UA-2-oppgave. | Før neste RLS-avhengig host-akseptanse regnes som reelt bevis for isolasjon (påvirker også tidligere "host-verified" D-30/UA-1-runder som aldri eksplisitt testet RLS-deny-veien) |

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
| Q-20 | **UA-2 P0-gap (registrert ved P0-bygging 2026-08-14, IKKE en blokker for P0 - dokumentert i docs/UA2_KNOWLEDGE_DPIA.md).** Kunnskaps-ingestion har kun MYK sletting (tombstone: `deleted=true`, innhold blir stående i databasen) - ingen hard-delete-vei for et fremtidig GDPR-slettekrav på persondata som havner i ingestet fil-/GitHub-innhold. Løsning finnes (enkel `DELETE FROM knowledge_documents WHERE ...`), men er bevisst ikke bygget i P0 (ingen påvist behov ennå, og en hard-delete-operasjon bør ha egen policy-/audit-vurdering før den finnes). | Før UA-2 P1 (flere kilder = mer persondata-eksponering) eller ved første faktiske slettekrav | Design egen "purge"-operasjon med samme audit-disiplin som resten av Jarvis (aldri stille slette uten spor) |

## Parkert (bevisst utsatt)

| ID | Tema | Tidligst |
|---|---|---|
| Q-13 | Bil-integrasjon (CarPlay/bil-API) | Etter fase 8 |
| Q-14 | Apple Health / `health`-space-innhold og lokal modell for helse | Etter fase 8, krever DPIA-utvidelse |
| Q-15 | Flere personer/familie som egne `person_id` med egne spaces | Etter første produksjonsversjon |
| Q-16 | Andre bølge-integrasjoner (CRM/Dennis, Fiken/Folio, telefoni, Slack/Teams) | Etter fase 7 |
| Q-17 | Autonom selvreparasjon via signerte runbooks | Etter fase 10-måling |

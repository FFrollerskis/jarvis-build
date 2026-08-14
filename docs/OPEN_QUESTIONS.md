# Jarvis – åpne spørsmål

**Status:** Utkast v1.0. Spørsmål lukkes ved å flytte svaret til
[DECISIONS_AND_ASSUMPTIONS.md](DECISIONS_AND_ASSUMPTIONS.md) med beslutnings-ID.

## Lukkede spørsmål

| ID | Utfall |
|---|---|
| Q-01 | **Lukket 2026-08-12** → D-18: Masterplan v2.1 behandles som eneste tilgjengelige kildedokument; nye eksplisitte Tobias-beslutninger kan overstyre når de dokumenteres i CANONICAL_SPEC/DECISIONS |
| Q-02 | **Lukket 2026-08-12** → D-18–D-23: A-01/A-02/A-04/A-05/A-06 bekreftet; A-03 erstattet av ny maskinvareplan (D-20) |

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
| Q-18 | **BLOCKER (reprodusert deterministisk, D-30 hardening-runde 3).** ToolGateway-idempotensdedupe gjelder også A-klasse READ-verktøy (idempotent_external=true, ingen preflight_action): gjentatt identisk lesekall i SAMME session_id (voice-sesjoner gjenopptas på tvers av taleturer via `SessionService.resumeOrCreate`) returnerer `deduplicated:true` med `output:null` - modellen får en stille tom "suksess" i stedet for ekte data ved andre gangs "hva står på kalenderen" i samme sesjon. Bevis: `modules/tool-gateway/test/q18-read-dedupe.test.ts` (2 tester, embedded PG). **Foreslått minste fix (IKKE implementert - krever egen godkjent BO, "ikke redesign ToolGateway" var eksplisitt grense for hardening-runden):** hopp over `tool_executions`-dedupe-oppslaget når `capability_class === "A"` i `ToolGateway.execute()` (modules/tool-gateway/src/gateway.ts, rundt linje 209) - rene lesninger har intet side-effekt å beskytte mot duplisering; dedupe-formålet (§21/§19 i BO-11) gjelder eksplisitt C/D-mutasjoner og skal IKKE røres. | Neste hardening-runde (egen BO) | Målrettet fix + regresjonstest som viser C/D-dedupe uendret; live-observerbar sjekk i `bo12-voice-soak.ts` turn 2 vs. 6/10 (samme kalenderspørsmål) |

## Parkert (bevisst utsatt)

| ID | Tema | Tidligst |
|---|---|---|
| Q-13 | Bil-integrasjon (CarPlay/bil-API) | Etter fase 8 |
| Q-14 | Apple Health / `health`-space-innhold og lokal modell for helse | Etter fase 8, krever DPIA-utvidelse |
| Q-15 | Flere personer/familie som egne `person_id` med egne spaces | Etter første produksjonsversjon |
| Q-16 | Andre bølge-integrasjoner (CRM/Dennis, Fiken/Folio, telefoni, Slack/Teams) | Etter fase 7 |
| Q-17 | Autonom selvreparasjon via signerte runbooks | Etter fase 10-måling |

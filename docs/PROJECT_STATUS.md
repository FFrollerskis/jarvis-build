# PROJECT STATUS

**Oppdatert:** 2026-09-20 (branch `claude/fase-voice-daily-use`, fra fersk `origin/main` HEAD `53aa8f3` =
"Charlie"-linjen + Infisical/dashboard-lese-del (D-208/D-209/D-210/D-211) MERGET). **Ny slice: task #120 -
`apps/voice-gateway` koblet til en faktisk daglig-bruk-overflate (D-212) - klar for commit/push/draft PR.**

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## ARBEIDSFORM-ENDRING (D-192, 2026-09-19) - GJELDENDE VIDERE

Tobias har DIREKTE (i interaktiv chat, ikke via issue #68 `ARCHITECT_TASK`) bedt om å bygge resten av
planen sammen med Claude uten ChatGPT-arkitekten som mellomledd, helt til punktet der videre fremgang
faktisk krever credentials/kontoer/MCP-koblinger - IKKE start ny scope utover masterplanen. issue #68
BEHOLDES som logg. Claude har STÅENDE FULLMAKT til å merge rutinemessige PR-er når CI er grønt/tester
består/ingen åpne funn. D-201 presiserer sluttmålet: hele masterplanen bygget/fungerende, ALLE eksterne
integrasjoner unntatt `Fiken`/`Walley` (permanent ekskludert), en helt autonom agent, drift på
UGREEN-NAS-en + Tobias sin PC (`gemma_local`) som tilleggskraft inntil dedikert maskin. Se
D-192/D-201 i DECISIONS_AND_ASSUMPTIONS.md og `CLAUDE.md` §Merge-autoritet.

**VIKTIG PRESEDENS (D-208, 2026-09-20):** D-192s delegering er IKKE ubegrenset - den gjelder rutine-
implementasjonsvalg INNENFOR eksisterende arkitektur/CLAUDE.md sine Ufravikelige regler, ALDRI en
fullmakt til å fjerne selve håndhevingsmekanismen en ufravikelig regel krever skal eksistere, selv når
eieren eksplisitt og informert ber om det (Tobias ba to ganger om full, ugjennomgått live-selvpatching
av sikkerhetskritisk kode - AVSLÅTT SOM SPESIFISERT, erstattet med en trygg to-lags modell, se D-208).
**Samme klasse grense bekreftet en gang til denne økten (D-212):** `processor_terms_status` på
OpenAI STT/TTS er en hardkodet, kildekode-kommentert "aldri sett denne verdien selv"-blokkering (Q-32
punkt 1) - en HARD EKSTERN/JURIDISK BLOKKERING Tobias selv må løse, ALDRI noe standing delegering dekker.

## Hvor `main` står nå

- **PR #106-#120 MERGET.** Gemma-first-sagaen, UA-11 Executive Mode "K2" (D-207), HELE "Charlie"-linjen
  (personlighet D-208/selv-bevissthet D-209/minneverifisering D-210, PR #117-#119), Infisical-wiring +
  integrasjons-dashboard lese-del (D-211, PR #120) - se git-historikk/DECISIONS_AND_ASSUMPTIONS.md,
  ikke gjentatt her.
- **NY slice (IKKE ennå committet): voice-gateway daglig-bruk-overflate (D-212, task #120).**
  Kildekode-audit fant at `apps/voice-gateway` var FERDIG BYGGET (WS-transport, VAD, barge-in,
  grant-basert enhetsautoritet D-123) men manglet BEGGE de to tingene som gjør den brukbar: en klient
  og en docker-compose-tjeneste.
  - **Levert:** `apps/web/voice.html` - gjenbruker SAMME Ed25519-enhetsnøkkel/enrollment som
    `dashboard.html` (samme localStorage-nøkkel, samme fysiske enhet), signerer en `/devices/challenge`
    og sender den som `device_proof` inne i WS `start`-meldingen, strømmer mikrofon som PCM16 16 kHz
    (nedsamplet i klienten) og spiller `tts_frame` PCM16 24 kHz via en planlagt Web Audio-kø med
    `tts_cancelled`-avbrudd (barge-in). WS-adressen er konfigurerbar (topologi varierer dev-PC/NAS/
    compose). Ny `GET /voice`-rute i `apps/api/src/server.ts` (`WEB_VOICE`), IDENTISK mønster som
    `GET /dashboard`. Ny `voice-gateway`-tjeneste i `infra/local/docker-compose.yml` (samme
    `api.Dockerfile`-image som api/worker, `JARVIS_CORE_URL` peker på api-tjenestens container-interne
    adresse, helsesjekk mot `/health`).
  - **BEVISST IKKE rørt (HARD EKSTERN/JURIDISK BLOKKERING, Q-32 punkt 1):** `processor_terms_status:
    "NOT_VERIFIED"` på `OpenAiStt`/`OpenAiTts` - REELL taledialog via OpenAI forblir policy-blokkert
    helt til Tobias selv gjør den juridiske/eier-verifiseringen. `voice.html` viser avslaget ÆRLIG i et
    eget panel som navngir Q-32 - IKKE en generisk feil, og IKKE noe Jarvis/Claude kan/vil løse selv.
  - 13 nye DB-uavhengige strukturtester (`apps/api/test/voice-page-wiring.test.ts`,
    `modules/core/test/d212-voice-gateway-compose-wiring.test.ts`) + hele den eksisterende
    `apps/voice-gateway/test/`-suiten (77 DB-uavhengige tester uendret grønne, `voice-e2e.test.ts`
    uendret kjent sandbox-begrensning). `pnpm -w typecheck` (31 pakker) + `npx eslint .` rene.

## Blokkeringer

Ingen kjente kode-blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET,
dekker resten av masterplanen: Growth-stack live-evidens, reelle Finance-transaksjoner (Stripe),
iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR. Q-32 punkt 1 (OpenAI som
taleprosessor) og punkt 3 (lokal whisper.cpp/piper) er egne, eier-/eksterne blokkeringer - se
`docs/OPEN_QUESTIONS.md`.

## Neste oppgave

1. **Fullfør denne sliceen (D-212):** secret-scan, commit, push til fersk branch, draft PR, abonner.
2. **Følgeoppgave (allerede opprettet, task #122):** connector credential-SKRIVING + utvidet
   "test connector"-mutasjonsflyt for de resterende connectorene (D-211s bevisste avgrensning) - krever
   en egen risikoklassifisering og en egen, policy-gatet mutasjonsrute.
3. **Deretter (task #121):** design + bygg den trygge to-lags selvendrings-modellen - IKKE full
   ugjennomgått selvpatching, se D-208.
4. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer, OG Q-32 punkt 1
   (OpenAI som taleprosessor - juridisk/eier-verifisering) og punkt 3 (whisper.cpp/piper-installasjon)
   hvis lokal/health-space tale ønskes.

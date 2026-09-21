# PROJECT STATUS

**Oppdatert:** 2026-09-21 (branch `claude/status-update-125-merge` basert på `origin/main` HEAD
`822b4ec`). **Task #125 (D-217) MERGET (PR #128). Kodbart arbeid innenfor denne øktens D-192-scope
er nå reelt oppbrukt - se "Neste oppgave".**

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
fullmakt til å fjerne selve håndhevingsmekanismen en ufravikelig regel krever skal eksistere. Samme
grense bekreftet igjen for tale (D-212, Q-32 punkt 1) og for selvendring (D-208→D-214): eieren avslo
full ugjennomgått selvpatching TO GANGER etter eksplisitt risikogjennomgang - den vedtatte retningen
var et to-lags-kompromiss, ikke en full fullmakt.

## Hvor `main` står nå

- **PR #106-#128 MERGET.** Gemma-first-sagaen, UA-11 Executive Mode "K2" (D-207), HELE "Charlie"-linjen
  (personlighet D-208/selv-bevissthet D-209/minneverifisering D-210, PR #117-#119), Infisical-wiring +
  integrasjons-dashboard lese-del (D-211, PR #120), voice-gateway daglig-bruk-overflate (D-212, PR #121),
  connector credential-skriving + utvidet live_test (D-213, PR #122), trygg selvendring - to-lags-
  modellen (D-214, PR #123), selvendring - EKTE requires_approval-produsent for vilkårlig kode + merge-
  koblingen (D-215, PR #125), UA-11 executive dashboard mutasjons-delen (D-216, PR #126), lokal
  whisper.cpp/piper STT/TTS - EKTE subprosess-implementasjon (D-217, PR #128) - se
  git-historikk/DECISIONS_AND_ASSUMPTIONS.md, ikke gjentatt her.
- **D-217 (task #125, PR #128) - kort oppsummert (full begrunnelse i DECISIONS_AND_ASSUMPTIONS.md):**
  `LocalWhisperStt.startStream()` bufrer PCM, pakker til WAV og sender bytene DIREKTE på den spawnede
  prosessens STDIN (`-f -`) - ALDRI til fil. `LocalPiperTts.synthesize()` er EKTE strømmende (tekst
  til stdin, rå PCM fortløpende fra stdout), `cancel()` spawner `detached: true` og dreper HELE
  prosessgruppen (`process.kill(-pid, "SIGTERM")`) for §15/§16-barge-in. To reelle funn fanget av
  tester FØR commit: (1) første whisper.cpp-forsøk skrev til en midlertidig fil - `test/
  d30-foundation.test.ts` sin eksisterende §22-personvern-test fanget det umiddelbart, rettet til
  STDIN-piping; (2) første piper-forsøk kalte `kill()` på kun direkte-PID-en - en ny test med en
  faket hengende binær avdekket at en bash-wrapper sin `sleep`-grandbarn holdt stdout-pipen åpen,
  rettet med prosessgruppe-kill. Begge wiret inn i `main.ts` som fallback-tier (etter OpenAI, FØR
  `MarkerStt`/`FakeTts`). `available()` krever nå BÅDE binær OG modellsti (nye
  `JARVIS_WHISPER_MODEL`/`JARVIS_PIPER_MODEL`). 20 nye tester grønne mot fakede binær-skript, hele
  eksisterende `apps/voice-gateway`-suiten (unntatt `voice-e2e.test.ts` sitt kjente DB-gap) uendret
  grønn. `available()` forblir `false` i praksis til Tobias installerer binærene/modellene (Q-32
  punkt 3, uendret eier-avhengighet). CI grønt på alle 6 jobber (begge parallelle push/pull_request-
  kjøringer), ingen åpne review-tråder, merget under D-192 med to-forelder-merge (`822b4ec`).

## Andre åpne PR (utenfor denne øktens D-192-scope)

- **PR #97 (W1 watchdog produksjons-wiring, D-180)**, branch `claude/fase-w1-watchdog-runtime-
  durability`, opprettet 2026-09-19 via issue #68 sin `ARCHITECT_TASK`-protokoll - IKKE del av denne
  øktens direkte D-192-chat-arbeid. CI grønt (alle 6 jobber), men PR-en selv-rapporterer
  `HOST_ACCEPTANCE_STATUS=NOT_RUN`/`MERGE_AUTHORIZED=false`/`SELF_APPROVAL=false`: den krever ekte
  Docker/Postgres-host-kjøring av det bygde akseptanseharnesset OG en uavhengig arkitektgjennomgang
  FØR merge - begge utenfor hva som kan gjøres i denne sandbox-økten. Ligger fortsatt åpen og venter.

## Blokkeringer

Ingen kjente kode-blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET,
dekker resten av masterplanen: Growth-stack live-evidens, reelle Finance-transaksjoner (Stripe),
iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR. Q-32 punkt 1 (OpenAI som
taleprosessor) er en egen, ekstern blokkering - se `docs/OPEN_QUESTIONS.md`. Q-32 punkt 3 (lokal
whisper.cpp/piper) er nå KUN en host-installasjonsavhengighet (kodegapet lukket av D-217) - se der.
PR #97 (W1 watchdog) venter på host-akseptansekjøring + uavhengig arkitektgjennomgang (se over).
D-35s 10-punkts host-produksjonsport for Infisical fortsatt ikke runtime-verifisert (uendret fra
D-211). Embedded-Postgres DB-avhengige tester (`initdb: Permission denied`) kan fortsatt ikke kjøres i
DENNE sandbox-økten - kjent, uendret begrensning; CI (GitHub Actions) kjører dem derimot uten
problemer.

## Neste oppgave

Det lokalt kodbare innenfor denne øktens D-192-scope er nå reelt oppbrukt - alle identifiserte
rutineoppgaver som ikke krever eksterne credentials/host-handlinger er implementert og merget
(PR #106-#128). Gjenstående arbeid er enten:

1. **Ekstern/host-avhengig, ikke kodbart herfra:** legg frem en samlet oversikt over API-nøkler/
   kontoer/MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer, OG Q-32
   punkt 1 (OpenAI som taleprosessor - juridisk/eier-verifisering) og punkt 3 (whisper.cpp/piper-
   installasjon, nå kun host-handling gjenstående, se D-217).
2. **PR #97 (W1 watchdog):** venter på Tobias/arkitekt for host-akseptansekjøring + uavhengig
   arkitektgjennomgang - ikke noe Claude kan drive videre alene i denne sandbox-økten.

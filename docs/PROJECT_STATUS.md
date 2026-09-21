# PROJECT STATUS

**Oppdatert:** 2026-09-21 (branch `claude/status-update-130-merge` basert på `origin/main` HEAD
`19cd6b7`). **PR #130 (D-218/D-219/D-220) MERGET. Alle tre "silent error swallowing"-fikser i drift.
Ingen kjent gjenstående lokalt kodbart arbeid akkurat nå - se "Neste oppgave".**

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

**LÆRDOM (D-218→D-220, 2026-09-21):** "lokalt kodbart arbeid oppbrukt" er IKKE en selv-uttalt
konklusjon som skal stå uimotsagt - Tobias sitt "Fortsatt å bygg"/"fortsett å bygg" (TRE separate
ganger samme dag) etter nøyaktig en slik påstand utløste tre runder som alle fant en reell, ubestridt
bug av SAMME anti-mønster-klasse (`.catch(() => undefined)` som svelger feil sporløst). Praktisk
konklusjon for neste runde: sjekk FØRST om forrige runde selv la igjen en navngitt, uløst kandidat FØR
et helt nytt, bredt søk startes - billigere å hente fra egen logg. **D-220s egen CI-runde, ny lærdom:**
en påstand om DB-atferd i en decision-log-post skal ALDRI regnes bekreftet før CI faktisk har kjørt
testen som beviser den, selv når koden ser åpenbart riktig ut - `build-test` var den FØRSTE faktiske
kjøringen av test R i denne sandbox-begrensede økten, og fant en reell feil i testens EGEN antakelse
(rettet i en fjerde commit, samme PR, FØR merge - se D-220 i DECISIONS_AND_ASSUMPTIONS.md).

## Hvor `main` står nå

- **PR #106-#130 MERGET.** Gemma-first-sagaen, UA-11 Executive Mode "K2" (D-207), HELE "Charlie"-linjen
  (personlighet D-208/selv-bevissthet D-209/minneverifisering D-210, PR #117-#119), Infisical-wiring +
  integrasjons-dashboard lese-del (D-211, PR #120), voice-gateway daglig-bruk-overflate (D-212, PR #121),
  connector credential-skriving + utvidet live_test (D-213, PR #122), trygg selvendring - to-lags-
  modellen (D-214, PR #123), selvendring - EKTE requires_approval-produsent for vilkårlig kode + merge-
  koblingen (D-215, PR #125), UA-11 executive dashboard mutasjons-delen (D-216, PR #126), lokal
  whisper.cpp/piper STT/TTS - EKTE subprosess-implementasjon (D-217, PR #128), tre uavhengige "silent
  error swallowing"-fikser (D-218 scheduler/D-219 policy-avslag-audit/D-220 erasure-fail-status, PR
  #130) - se git-historikk/DECISIONS_AND_ASSUMPTIONS.md, ikke gjentatt her.
- **D-218→D-220 (PR #130) - kort oppsummert (full begrunnelse i DECISIONS_AND_ASSUMPTIONS.md):** tre
  uavhengige forekomster av SAMME anti-mønster (`.catch(() => undefined)`), funnet i tre påfølgende
  "fortsett å bygg"-runder samme dag, bundlet i ÉN PR. `DailyScheduler.start()` (D-218, DEN DELTE
  mekanismen bak ALLE 17 schedulerte jobbene i `apps/api/src/main.ts`), `ToolGateway.deny()` (D-219,
  ALLE 12+ avslags-stedene i `execute()`), `ErasureService`s `failErasureRequest()`-persistering (D-220,
  GDPR-sletteforespørselens EGEN revisjonslogg) - alle tre fikk SAMME etablerte remedie (strukturert
  `console.error`-logging, isolasjon/fail-safe-oppførsel uendret, samme mønster som D-180/D-196/PR #79).
  D-220 sin FØRSTE testversjon hadde en feil DB-atferds-antakelse ("raden blir værende på pending") -
  CI fanget dette (`TypeError` fordi ingen rad fantes), rettet FØR merge til å korrekt beskrive at
  BEGGE samtidige innsettinger (hovedtransaksjon OG fail-status-persist) ruller tilbake sammen, altså
  INGEN rad i det hele tatt, ikke en misvisende `pending`-rad. CI grønt på alle 6 jobber (siste head),
  ingen åpne review-tråder, merget under D-192 med to-forelder-merge (`19cd6b7`).

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

1. **Fersk, BREDT kode-nivå gap-søk FØRST** (grep etter selve `.catch(() => undefined)`-anti-mønsteret
   og lignende på tvers av HELE kodebasen, se D-218/D-219-lærdommen) hvis bedt om å fortsette å bygge -
   D-219 sin egen "vurdert og bevisst IKKE flagget"-liste (git-auth `chmod()`, Telegram/GitHub-kø-
   vakter) er allerede sjekket og bekreftet lav prioritet to ganger, ingen kjent uløst kandidat
   gjenstår fra DENNE anti-mønster-klassen akkurat nå.
2. Når det kodbare virkelig er oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer, OG Q-32 punkt 1
   (OpenAI som taleprosessor - juridisk/eier-verifisering) og punkt 3 (whisper.cpp/piper-installasjon,
   nå kun host-handling gjenstående, se D-217). PR #97 (W1 watchdog) venter uansett på Tobias/arkitekt.

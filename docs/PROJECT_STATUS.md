# PROJECT STATUS

**Oppdatert:** 2026-09-21 (branch `claude/fase-scheduler-error-logging` basert på `origin/main` HEAD
`27686f4`). **D-218+D-219+D-220 pushet til PR #130. CI (`build-test`) fanget en reell feil i D-220 sin
EGEN testantakelse (ikke i selve fiksen) - rettet lokalt, klar for en fjerde commit på SAMME branch
(se under). PR fortsatt åpen, ikke merget.**

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
et helt nytt, bredt søk startes - billigere å hente fra egen logg. **Ny lærdom, D-220s egen CI-runde:**
et antatt DB-konsekvens-resonnement ("raden blir værende på pending") kan være FEIL selv når selve
fiksen (loggingen) er riktig - når testsuiten ikke kan kjøres lokalt (embedded-Postgres-sandkasse-
gapet), er CI IKKE bare en formalitet, den er den FØRSTE faktiske utførelsen av testens egne
assertions. En påstand om DB-atferd i en decision-log-post skal derfor ALDRI regnes bekreftet før CI
faktisk har kjørt testen som beviser den - selv når koden ser åpenbart riktig ut.

## Hvor `main` står nå

- **PR #106-#129 MERGET.** Gemma-first-sagaen, UA-11 Executive Mode "K2" (D-207), HELE "Charlie"-linjen
  (personlighet D-208/selv-bevissthet D-209/minneverifisering D-210, PR #117-#119), Infisical-wiring +
  integrasjons-dashboard lese-del (D-211, PR #120), voice-gateway daglig-bruk-overflate (D-212, PR #121),
  connector credential-skriving + utvidet live_test (D-213, PR #122), trygg selvendring - to-lags-
  modellen (D-214, PR #123), selvendring - EKTE requires_approval-produsent for vilkårlig kode + merge-
  koblingen (D-215, PR #125), UA-11 executive dashboard mutasjons-delen (D-216, PR #126), lokal
  whisper.cpp/piper STT/TTS - EKTE subprosess-implementasjon (D-217, PR #128) - se
  git-historikk/DECISIONS_AND_ASSUMPTIONS.md, ikke gjentatt her.

## PR #130 (D-218→D-220) - samlet "silent error swallowing"-fikserunde, branch `claude/fase-scheduler-error-logging`

Tre uavhengige forekomster av SAMME anti-mønster (`.catch(() => undefined)`), funnet i tre påfølgende
"fortsett å bygg"-runder samme dag, bundlet i ÉN PR (samme klasse, samme øktdag, ingen grunn til tre
separate PR-er). Samme etablerte remedie i alle tre (SAMME mønster som D-180/D-196 allerede brukte
andre steder): isolasjon/fail-safe-oppførsel UENDRET, men feilen strukturert `console.error`-logget.

- **D-218 (pushet, PR #130 commit 1, CI grønt):** `DailyScheduler.start()` (`modules/tool-gateway/src/
  scheduler.ts`) - DEN DELTE mekanismen bak ALLE 17 schedulerte jobbene i `apps/api/src/main.ts`, kun
  3 av 17 logget sitt EGET, snevrere tilfelle. `daily_scheduler_tick_failed` strukturert logget. Ny
  testfil `scheduler.test.ts` (3 tester, embedded-Postgres).
- **D-219 (pushet, PR #130 commit 2, CI grønt):** `ToolGateway.deny()` (`modules/tool-gateway/src/
  gateway.ts`) - kalt fra ALLE 12+ avslags-stedene i `execute()` (revisjonssporet CLAUDE.md §6 skal
  bevises av). `tool_denied_audit_write_failed` strukturert logget, avslaget returneres fortsatt
  normalt. Ny testfil `gateway-deny-audit-failure.test.ts` (1 test, HELT DB-uavhengig).
- **D-220 (pushet PR #130 commit 3 - CI FANT EN FEIL I TESTEN, rettet lokalt, klar for commit 4):**
  `ErasureService.executeErasure()` sin `failErasureRequest(...)`-persistering (`modules/erasure/src/
  erasure-service.ts`) - smalere (ETT kallsted), men GDPR-sletteforespørselens EGEN revisjonslogg.
  `erasure_request_fail_status_persist_failed` strukturert logget (begge feilene: opprinnelig
  sletteforsøk-feil OG persist-feil) - FIKSEN SELV var riktig fra første commit. **CI-funn:** min egen
  testantakelse ("raden blir værende på `pending` for alltid") var FEIL - `insertPendingErasureRequest()`
  kjører i SAMME transaksjon som selve sletteforsøket, så når den transaksjonen ruller tilbake (samme
  mekanisme som eksisterende test N), ruller `pending`-innsettingen tilbake MED den. Feiler BEGGE
  innsettinger, finnes det derfor INGEN rad i det hele tatt - ikke en misvisende "pending"-rad. Testens
  assertion (`ledgerRow.rows[0].status`) kastet `TypeError: Cannot read properties of undefined` fordi
  raden faktisk ikke fantes. Rettet: testen asserter nå `ledgerRow.rows).toHaveLength(0)`, kode-
  kommentaren i `erasure-service.ts` og D-220 sin egen decision-log-tekst er begge korrigert til å
  beskrive den FAKTISKE konsekvensen (ingen rad, ikke en gjenværende `pending`-rad). Se D-220 sitt eget
  "CI-FANGET FUNN"-avsnitt i DECISIONS_AND_ASSUMPTIONS.md for full detalj.
- `pnpm -w typecheck`/`npx eslint .` rene (alle fire runder, inkl. CI-rettelsen). `modules/tool-gateway`-
  suite re-kjørt etter D-219: 294/294 grønne. `modules/erasure`-suite: KAN IKKE kjøres i denne sandbox-
  økten i det hele tatt (HELE suiten krever embedded Postgres, SAMME kjente `initdb: Permission denied`-
  begrensning) - CI var derfor den FØRSTE faktiske kjøringen av test R, og fant nettopp derfor den reelle
  feilen i testens egen antakelse (se lærdom over).
- **Andre kandidater vurdert og bevisst IKKE flagget (git-auth `chmod()`, Telegram/GitHub-kø-vakter):**
  lav-innsats/ikke-sikkerhetsrelevant, bekreftet fortsatt lav prioritet i D-220-runden også.
- **Gjenstår FØR merge:** commit CI-rettelsen (kode-kommentar + test + decision-log), push, overvåk CI
  på nytt, merge under D-192 når grønt/uten åpne funn.

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

1. **Fullfør D-218→D-220 (PR #130):** commit CI-rettelsen, push, overvåk CI på nytt, merge under D-192
   når grønt/uten åpne funn.
2. Etter dette: sjekk FØRST om denne runden selv la igjen en navngitt, uløst kandidat (se D-220s egen
   "vurdert og bevisst IKKE flagget"-liste over) FØR et helt nytt, bredt kode-nivå gap-søk startes -
   ikke stol blindt på forrige økts "Neste oppgave"-liste under punkt 3 alene.
3. Når det kodbare virkelig er oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer, OG Q-32 punkt 1
   (OpenAI som taleprosessor - juridisk/eier-verifisering) og punkt 3 (whisper.cpp/piper-installasjon,
   nå kun host-handling gjenstående, se D-217). PR #97 (W1 watchdog) venter uansett på Tobias/arkitekt.

# PROJECT STATUS

**Oppdatert:** 2026-09-21 (branch `claude/fase-scheduler-error-logging` basert på `origin/main` HEAD
`27686f4`). **D-218+D-219 pushet, PR #130 åpen med CI kjørende. D-220 (tredje forekomst av samme
anti-mønster) implementert lokalt oppå samme branch - kvalitetsporter kjørt, klar for commit/push/
PR-oppdatering (se under).**

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
bug av SAMME anti-mønster-klasse (`.catch(() => undefined)` som svelger feil sporløst) - D-218/D-219
via et fersk, bredt kode-nivå gap-søk (samme metodikk som D-195/D-196), D-220 ved ganske enkelt å
hente inn en kandidat D-219 SELV allerede hadde registrert i sin egen "vurdert og avvist"-liste.
Praktisk konklusjon for neste runde: sjekk FØRST om forrige runde selv la igjen en navngitt,
uløst kandidat FØR et helt nytt, bredt søk startes på nytt - billigere å hente fra egen logg.

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

- **D-218 (pushet, PR #130 commit 1):** `DailyScheduler.start()` (`modules/tool-gateway/src/
  scheduler.ts`) - DEN DELTE mekanismen bak ALLE 17 schedulerte jobbene i `apps/api/src/main.ts`, kun
  3 av 17 logget sitt EGET, snevrere tilfelle. `daily_scheduler_tick_failed` strukturert logget. Ny
  testfil `scheduler.test.ts` (3 tester, embedded-Postgres).
- **D-219 (pushet, PR #130 commit 2):** `ToolGateway.deny()` (`modules/tool-gateway/src/gateway.ts`) -
  kalt fra ALLE 12+ avslags-stedene i `execute()` (revisjonssporet CLAUDE.md §6 skal bevises av).
  `tool_denied_audit_write_failed` strukturert logget, avslaget returneres fortsatt normalt. Ny testfil
  `gateway-deny-audit-failure.test.ts` (1 test, HELT DB-uavhengig).
- **D-220 (IKKE ENNÅ PUSHET, klar for commit 3 på SAMME branch):** `ErasureService.executeErasure()`
  sin `failErasureRequest(...)`-persistering (`modules/erasure/src/erasure-service.ts`) - smalere (ETT
  kallsted), men GDPR-sletteforespørselens EGEN revisjonslogg: feiler persisteringen av `status=
  'failed'` selv, blir `erasure_requests`-raden værende på `pending` for alltid, uten varsel.
  `erasure_request_fail_status_persist_failed` strukturert logget (begge feilene: opprinnelig
  sletteforsøk-feil OG persist-feil). Ny test `erasure-service.test.ts` test R (embedded-Postgres,
  gjenbruker samme selv-restaurerende monkeypatch-mønster som eksisterende test N, utvidet med
  `connect()`-kall-telling for å treffe presist `failErasureRequest()` sitt EGET, separate connect-kall).
- `pnpm -w typecheck`/`npx eslint .` rene (alle tre runder). `modules/tool-gateway`-suite re-kjørt
  etter D-219: 294/294 grønne. `modules/erasure`-suite: typecheck/lint rene, selve testkjøringen KAN
  IKKE kjøres i denne sandbox-økten (HELE `modules/erasure`-suiten krever embedded Postgres, SAMME
  kjente `initdb: Permission denied`-begrensning - verifiseres av CI).
- **Andre kandidater vurdert og bevisst IKKE flagget (git-auth `chmod()`, Telegram/GitHub-kø-vakter):**
  lav-innsats/ikke-sikkerhetsrelevant, bekreftet fortsatt lav prioritet i D-220-runden også.
- **Gjenstår FØR merge:** secret-scan, commit D-220, push, oppdater PR #130 sin tittel/beskrivelse til
  å dekke alle tre fiksene, overvåk CI, merge under D-192 når grønt/uten åpne funn.

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

1. **Fullfør D-218→D-220 (PR #130):** secret-scan, commit D-220, push, oppdater PR-tittel/-beskrivelse
   til å dekke alle tre fiksene, overvåk CI, merge under D-192 når grønt/uten åpne funn.
2. Etter dette: sjekk FØRST om denne runden selv la igjen en navngitt, uløst kandidat (se D-220s egen
   "vurdert og bevisst IKKE flagget"-liste over) FØR et helt nytt, bredt kode-nivå gap-søk startes -
   ikke stol blindt på forrige økts "Neste oppgave"-liste under punkt 3 alene.
3. Når det kodbare virkelig er oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer, OG Q-32 punkt 1
   (OpenAI som taleprosessor - juridisk/eier-verifisering) og punkt 3 (whisper.cpp/piper-installasjon,
   nå kun host-handling gjenstående, se D-217). PR #97 (W1 watchdog) venter uansett på Tobias/arkitekt.

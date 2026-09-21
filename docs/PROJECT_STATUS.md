# PROJECT STATUS

**Oppdatert:** 2026-09-21 (branch `claude/fase-scheduler-error-logging` basert på `origin/main` HEAD
`27686f4`). **Task #126-128 (D-218) OG en påfølgende D-219-fiks (samme bug-klasse, funnet i en ny
gap-søk-runde) begge implementert på SAMME branch/PR #130 - kvalitetsporter kjørt lokalt, klar for
push/PR-oppdatering (se under).**

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

**LÆRDOM (D-218/D-219, 2026-09-21):** "lokalt kodbart arbeid oppbrukt" er IKKE en selv-uttalt
konklusjon som skal stå uimotsagt - Tobias sitt "Fortsatt å bygg"/"fortsett å bygg" (TO separate
ganger samme dag) etter nøyaktig en slik påstand utløste to runder av et fersk, kode-nivå gap-søk
(samme metodikk som D-195/D-196) som begge fant en reell, ubestridt bug av SAMME anti-mønster-klasse
(`.catch(() => undefined)` som svelger feil sporløst). D-219 sin egen konklusjon: et grep etter selve
ANTI-MØNSTERET på tvers av HELE kodebasen (ikke bare innenfor ett allerede identifisert underdomene)
er den pålitelige metoden - en "oppbrukt"-konklusjon skal alltid kunne motbevises av et friskt,
bredt søk før den aksepteres som endelig.

## Hvor `main` står nå

- **PR #106-#129 MERGET.** Gemma-first-sagaen, UA-11 Executive Mode "K2" (D-207), HELE "Charlie"-linjen
  (personlighet D-208/selv-bevissthet D-209/minneverifisering D-210, PR #117-#119), Infisical-wiring +
  integrasjons-dashboard lese-del (D-211, PR #120), voice-gateway daglig-bruk-overflate (D-212, PR #121),
  connector credential-skriving + utvidet live_test (D-213, PR #122), trygg selvendring - to-lags-
  modellen (D-214, PR #123), selvendring - EKTE requires_approval-produsent for vilkårlig kode + merge-
  koblingen (D-215, PR #125), UA-11 executive dashboard mutasjons-delen (D-216, PR #126), lokal
  whisper.cpp/piper STT/TTS - EKTE subprosess-implementasjon (D-217, PR #128) - se
  git-historikk/DECISIONS_AND_ASSUMPTIONS.md, ikke gjentatt her.
- **D-218+D-219 - IKKE ENNÅ PUSHET/PR-OPPDATERT, på branch `claude/fase-scheduler-error-logging`
  (PR #130 allerede åpnet for D-218, D-219 legges til som andre commit på SAMME PR - begge er
  uavhengige forekomster av samme anti-mønster, funnet i to påfølgende søk samme dag, ingen grunn til
  separate PR-er):**
  - **D-218:** `DailyScheduler.start()` (`modules/tool-gateway/src/scheduler.ts`) hadde
    `.catch(() => undefined)` som ytterste feilhåndtering - DEN DELTE mekanismen bak ALLE 17
    schedulerte jobbene i `apps/api/src/main.ts`, kun 3 av 17 logget sitt EGET, snevrere tilfelle.
    Fikset i selve mekanismen: `daily_scheduler_tick_failed` strukturert logget. Ny testfil
    `modules/tool-gateway/test/scheduler.test.ts` (3 tester).
  - **D-219 (denne søk-runden):** `ToolGateway.deny()` (`modules/tool-gateway/src/gateway.ts`) hadde
    SAMME `.catch(() => undefined)` rundt sin egen audit-skriving - kalt fra ALLE 12+ avslags-stedene
    i `execute()` (revisjonssporet CLAUDE.md §6 "Policy Gateway aldri hoppes over" skal bevises av).
    Fikset: `tool_denied_audit_write_failed` strukturert logget, avslaget returneres fortsatt normalt
    (fail-safe uendret). Ny testfil `modules/tool-gateway/test/gateway-deny-audit-failure.test.ts`
    (1 test, HELT DB-uavhengig - kjører rent i denne sandboxen, i motsetning til D-218 sin test).
    Kandidat vurdert og registrert for EGEN fremtidig slice (ikke løst her): `modules/erasure/src/
    erasure-service.ts` sin `failErasureRequest(...).catch(() => undefined)` - reell, men smalere
    (ett kallsted). Andre `.catch()`-treff (git-auth chmod, Telegram/GitHub-kø-vakter) vurdert og
    bevisst IKKE flagget - lav-innsats/ikke-sikkerhetsrelevant.
  - `pnpm -w typecheck`/`npx eslint .` rene (begge runder). Full `modules/tool-gateway`-suite
    re-kjørt etter D-219: 294/294 grønne (opp fra 293 - D-219s test er selv DB-uavhengig og talte med),
    103 forventet skip, SAMME 12 kjente `initdb: Permission denied`-sandkasse-filer som D-218, uendret.
  - **Gjenstår FØR merge:** secret-scan, commit D-219, push, oppdater PR #130 sin tittel/beskrivelse
    til å dekke begge fiksene, overvåk CI, merge under D-192 når grønt/uten åpne funn.

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

1. **Fullfør D-218+D-219 (PR #130):** secret-scan, commit D-219, push, oppdater PR-tittel/-beskrivelse
   til å dekke begge fiksene, overvåk CI, merge under D-192 når grønt/uten åpne funn.
2. Etter dette: et NYTT, fersk, BREDT kode-nivå gap-søk (grep etter selve anti-mønsteret på tvers av
   HELE kodebasen, se D-219-lærdommen over) bør kjøres FØR man igjen konkluderer "oppbrukt" - ikke stol
   blindt på forrige økts "Neste oppgave"-liste under punkt 3 alene. `modules/erasure/src/
   erasure-service.ts` sin `failErasureRequest()`-svelging (se D-219) er en konkret, allerede
   identifisert kandidat for en slik neste runde.
3. Når det kodbare virkelig er oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer, OG Q-32 punkt 1
   (OpenAI som taleprosessor - juridisk/eier-verifisering) og punkt 3 (whisper.cpp/piper-installasjon,
   nå kun host-handling gjenstående, se D-217). PR #97 (W1 watchdog) venter uansett på Tobias/arkitekt.

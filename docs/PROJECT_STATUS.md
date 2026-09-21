# PROJECT STATUS

**Oppdatert:** 2026-09-21 (branch `claude/fase-scheduler-error-logging` basert på `origin/main` HEAD
`27686f4`). **Task #126-128 (D-218) implementert, kvalitetsporter kjørt lokalt - klar for
commit/push/draft-PR (se under).**

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

**LÆRDOM (D-218, 2026-09-21):** "lokalt kodbart arbeid oppbrukt" er IKKE en selv-uttalt konklusjon som
skal stå uimotsagt - Tobias sitt "Fortsatt å bygg" etter nøyaktig en slik påstand utløste et fersk,
kode-nivå gap-søk (samme metodikk som D-195/D-196) som fant en reell, ubestridt bug (se under). Fremover:
en "oppbrukt"-konklusjon skal alltid kunne motbevises av et friskt søk før den aksepteres som endelig.

## Hvor `main` står nå

- **PR #106-#129 MERGET.** Gemma-first-sagaen, UA-11 Executive Mode "K2" (D-207), HELE "Charlie"-linjen
  (personlighet D-208/selv-bevissthet D-209/minneverifisering D-210, PR #117-#119), Infisical-wiring +
  integrasjons-dashboard lese-del (D-211, PR #120), voice-gateway daglig-bruk-overflate (D-212, PR #121),
  connector credential-skriving + utvidet live_test (D-213, PR #122), trygg selvendring - to-lags-
  modellen (D-214, PR #123), selvendring - EKTE requires_approval-produsent for vilkårlig kode + merge-
  koblingen (D-215, PR #125), UA-11 executive dashboard mutasjons-delen (D-216, PR #126), lokal
  whisper.cpp/piper STT/TTS - EKTE subprosess-implementasjon (D-217, PR #128) - se
  git-historikk/DECISIONS_AND_ASSUMPTIONS.md, ikke gjentatt her.
- **Task #126-128 (D-218) - IKKE ENNÅ PUSHET/PR-et, på branch `claude/fase-scheduler-error-logging`:**
  `DailyScheduler.start()` (`modules/tool-gateway/src/scheduler.ts`) hadde `.catch(() => undefined)`
  som ytterste feilhåndtering - EKSAKT samme bug-klasse D-180/D-196 allerede rettet andre steder, men
  ALDRI anvendt her. `DailyScheduler` er DEN DELTE mekanismen bak ALLE 17 schedulerte jobbene i
  `apps/api/src/main.ts` - kun 3 av 17 (daily-brief/business-weekly-brief/situation-sweep) logget sitt
  EGET, snevrere tilfelle, ALDRI et uventet unntak fra selve `claimToday()`/`markCompleted()`/
  `deliver()`. Verifisert REELT (ikke hypotetisk): `business-open-loop-sweep` sin
  `listBusinessTenantIds()`-kall ligger UTENFOR egen try/catch - en kastet feil der forsvant tidligere
  helt sporløst. Fikset I DEN DELTE MEKANISMEN (aldri per-kaller-patching av 17 steder): `start()` sin
  `.catch()` logger nå strukturert (`daily_scheduler_tick_failed` + job_name/instance_id/error), SAMME
  mønster som D-180/D-196. Ny testfil `modules/tool-gateway/test/scheduler.test.ts` (3 tester: deliver()
  kaster→logget+ikke markert fullført; claimToday() sitt eget DB-feil→samme sikkerhetsnett; vellykket
  levering→ingen støy, markCompleted() faktisk kjørt). Kandidater vurdert og AVVIST i samme søk: UA-9
  vision-klassifiserer (DPIA-governance-port + ingen reell bruker ennå), UA-10 helse-/lokasjonsbro
  (ingen eksisterende anomalideteksjon å bygge broen mot - ville vært å oppfinne terskler fra intet).
  `pnpm -w typecheck`/`npx eslint .` rene. Full `modules/tool-gateway`-suite re-kjørt: 293/293 grønne
  (utenom de 12 filene, inkl. selve `scheduler.test.ts`, som traff det kjente `initdb: Permission
  denied`-sandkasse-gapet - uendret, ikke en regresjon). **Gjenstår FØR PR:** secret-scan, commit, push,
  draft-PR, overvåk CI, merge under D-192 når grønt/uten åpne funn.

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

1. **Fullfør task #126-128 (D-218):** secret-scan, commit, push
   `claude/fase-scheduler-error-logging`, åpne draft-PR, abonner på PR-aktivitet, overvåk CI, merge
   under D-192 når grønt/uten åpne funn.
2. Etter dette: et NYTT, fersk kode-nivå gap-søk bør kjøres FØR man igjen konkluderer "oppbrukt" (se
   D-218-lærdommen over) - ikke stol blindt på forrige økts "Neste oppgave"-liste under punkt 3 alene.
3. Når det kodbare virkelig er oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer, OG Q-32 punkt 1
   (OpenAI som taleprosessor - juridisk/eier-verifisering) og punkt 3 (whisper.cpp/piper-installasjon,
   nå kun host-handling gjenstående, se D-217). PR #97 (W1 watchdog) venter uansett på Tobias/arkitekt.

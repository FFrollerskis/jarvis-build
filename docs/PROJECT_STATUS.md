# PROJECT STATUS

**Oppdatert:** 2026-09-21 (branch `claude/fase-erasure-rollback-error-logging` basert på `origin/main`
HEAD `8d211bc`). **D-221 (fjerde "silent error swallowing"-runde) implementert lokalt - kvalitetsporter
kjørt, klar for commit/push/draft-PR (se under).**

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

**LÆRDOM (D-218→D-221, 2026-09-21):** "lokalt kodbart arbeid oppbrukt" er IKKE en selv-uttalt
konklusjon som skal stå uimotsagt - Tobias sitt "Fortsatt å bygg"/"fortsett å bygg" (FIRE separate
ganger samme dag) etter nøyaktig en slik påstand utløste fire runder som alle fant en reell, ubestridt
bug av SAMME anti-mønster-klasse (`.catch(() => undefined)`/`catch {}` som svelger feil sporløst).
**D-220s CI-lærdom (DB-atferds-påstander må faktisk CI-verifiseres) ble denne gangen anvendt
PROAKTIVT, ikke reaktivt:** D-221 sine nye tester ble skrevet med eksplisitt, dokumentert resonnement
om `.catch()`-kjeding (krever et AVVIST løfte i mock-en, aldri en synkron `throw`) og om ekte
Postgres-tilkoblingers transaksjonstilstand (en test som SIMULERER en ROLLBACK-feil for kalleren må
likevel utføre en EKTE ROLLBACK FØR den simulerte avvisningen, ellers korrumperes senere, urelaterte
tester som gjenbruker samme pooled tilkobling) - begge feil ville vært nøyaktig den samme klassen
feilaktig DB-antakelse D-220 selv ble tatt for av CI. **D-221s egen metode-lærdom:** D-220 sin
editering av to filer etterlot TRE søsken i SAMME to filer, funnet først i en egen, fjerde runde - et
grep bør derfor lete etter BÅDE `.catch(() => undefined)` OG et bart `catch { }` UTEN fanget
feil-variabel (sistnevnte er et STERKERE varselsignal - det kan ikke engang logge originalfeilen uten
en kodeendring).

## Hvor `main` står nå

- **PR #106-#131 MERGET.** Gemma-first-sagaen, UA-11 Executive Mode "K2" (D-207), HELE "Charlie"-linjen
  (personlighet D-208/selv-bevissthet D-209/minneverifisering D-210, PR #117-#119), Infisical-wiring +
  integrasjons-dashboard lese-del (D-211, PR #120), voice-gateway daglig-bruk-overflate (D-212, PR #121),
  connector credential-skriving + utvidet live_test (D-213, PR #122), trygg selvendring - to-lags-
  modellen (D-214, PR #123), selvendring - EKTE requires_approval-produsent for vilkårlig kode + merge-
  koblingen (D-215, PR #125), UA-11 executive dashboard mutasjons-delen (D-216, PR #126), lokal
  whisper.cpp/piper STT/TTS - EKTE subprosess-implementasjon (D-217, PR #128), tre uavhengige "silent
  error swallowing"-fikser (D-218 scheduler/D-219 policy-avslag-audit/D-220 erasure-fail-status, PR
  #130) - se git-historikk/DECISIONS_AND_ASSUMPTIONS.md, ikke gjentatt her.
- **D-221 - IKKE ENNÅ PUSHET/PR-et, på ny branch (ikke opprettet ennå):** TRE gjenværende
  `.catch(() => undefined)`-søsken i SAMME to filer D-220 rørte ved, ALLE på ROLLBACK-stien
  (dobbelt-feil: hovedoperasjonen feiler OG opprydningen feiler også). `failErasureRequest()`
  (`modules/core/src/services/erasure-ledger.ts`) sin YTRE `catch { }` var ALVORLIGERE enn D-220 selv
  fikset: INGEN fanget feil-variabel, INGEN logging, INGEN rethrow - et feil i selve INSERT/COMMIT-en
  (den FAKTISK mest sannsynlige feilklassen, i motsetning til D-220s smalere `pool.connect()`-tilfelle)
  forsvant HELT sporløst, ALDRI nådd av D-220 sin egen logging ved kallestedet. `previewErasure()`/
  `executeErasure()` (`modules/erasure/src/erasure-service.ts`) sine ROLLBACK-kall svelget sin EGEN
  feil (original feil allerede synlig, men en rollback-feil OVENPÅ den var usynlig). Fikset med SAMME
  etablerte mønster (strukturert `console.error`, ingen atferdsendring - `failErasureRequest()` sin
  "kaster aldri"-kontrakt uendret). Nye tester S/T/U i `erasure-service.test.ts`, med to eksplisitt
  dokumenterte DB-korrekthets-presisjoner anvendt PROAKTIVT (se lærdom over). `pnpm -w typecheck`/
  `npx eslint .` rene. Kan IKKE kjøres i denne sandbox-økten (samme kjente `initdb: Permission
  denied`-begrensning) - verifiseres av CI. **Gjenstår FØR PR:** secret-scan, commit, push, draft-PR,
  overvåk CI, merge under D-192 når grønt/uten åpne funn.

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

1. **Fullfør D-221:** secret-scan, commit, push ny branch, åpne draft-PR, abonner på PR-aktivitet,
   overvåk CI, merge under D-192 når grønt/uten åpne funn.
2. Etter dette: et fersk, BREDT kode-nivå gap-søk (grep etter BÅDE `.catch(() => undefined)` OG et
   bart `catch { }` uten fanget feil-variabel, se D-221-lærdommen over) FØR man igjen konkluderer
   "oppbrukt" - ingen kjent, allerede-registrert uløst kandidat gjenstår fra DENNE anti-mønster-klassen
   akkurat nå (git-auth `chmod()`/Telegram-kø-vaktene er sjekket og bekreftet lav prioritet flere ganger).
3. Når det kodbare virkelig er oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer, OG Q-32 punkt 1
   (OpenAI som taleprosessor - juridisk/eier-verifisering) og punkt 3 (whisper.cpp/piper-installasjon,
   nå kun host-handling gjenstående, se D-217). PR #97 (W1 watchdog) venter uansett på Tobias/arkitekt.

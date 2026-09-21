# PROJECT STATUS

**Oppdatert:** 2026-09-21 (branch `claude/status-update-134-merge` basert på `origin/main` HEAD
`24e434b`). **PR #134 (D-222) MERGET. Fem runder "silent error swallowing"-fikser (D-218→D-222) alle
i drift. Ingen kjent, allerede-registrert uløst kandidat fra DENNE anti-mønster-klassen gjenstår - se
"Neste oppgave".**

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

**LÆRDOM (D-218→D-222, 2026-09-21):** "lokalt kodbart arbeid oppbrukt" er IKKE en selv-uttalt
konklusjon som skal stå uimotsagt - Tobias sitt "Fortsatt å bygg"/"fortsett å bygg" (FEM separate
ganger samme dag) etter nøyaktig en slik påstand utløste fem runder som alle fant en reell, ubestridt
bug av SAMME anti-mønster-klasse (`.catch(() => undefined)`/bar `catch {}` som svelger feil sporløst).
D-220 ble tatt av CI for en feil DB-atferds-antakelse i egen test; D-221 anvendte den lærdommen
PROAKTIVT (dokumenterte/verifiserte `.catch()`-kjeding krever avviste løfter, ikke synkrone kast, OG at
en simulert ROLLBACK-feil likevel må utføre en EKTE ROLLBACK for å ikke korrumpere senere tester FØR
push) - CI grønt på FØRSTE forsøk. D-221s egen metode-lærdom: D-220s editering av to filer etterlot
tre søsken i SAMME filer - et grep bør derfor lete etter BÅDE `.catch(() => undefined)` OG et bart
`catch { }` uten fanget feil-variabel (sistnevnte er et STERKERE signal - ingen mulighet til å logge
originalfeilen uten en kodeendring). D-222s egen metode-lærdom: da D-221 sin egen "ingen kjent uløst
kandidat gjenstår"-konklusjon (korrekt, INGEN navngitt kandidat var glemt) møtte en ny "fortsett å
bygg", var riktig neste steg et HELT FRISKT, BREDT søk på tvers av HELE `apps/`/`modules/` (ikke bare
filene forrige runde rørte ved) - fant fire helt nye forekomster i TRE andre moduler
(`tool-gateway`/`situations`/`apps/api`), utenfor erasure-domenet D-218→D-221 hadde fokusert på.
Praktisk konklusjon for neste runde: sjekk FØRST om forrige runde selv la igjen en navngitt, uløst
kandidat; er den listen tom, kjør et helt friskt bredt søk FØR "oppbrukt" konkluderes igjen.

## Hvor `main` står nå

- **PR #106-#134 MERGET.** Gemma-first-sagaen, UA-11 Executive Mode "K2" (D-207), HELE "Charlie"-linjen
  (personlighet D-208/selv-bevissthet D-209/minneverifisering D-210, PR #117-#119), Infisical-wiring +
  integrasjons-dashboard lese-del (D-211, PR #120), voice-gateway daglig-bruk-overflate (D-212, PR #121),
  connector credential-skriving + utvidet live_test (D-213, PR #122), trygg selvendring - to-lags-
  modellen (D-214, PR #123), selvendring - EKTE requires_approval-produsent for vilkårlig kode + merge-
  koblingen (D-215, PR #125), UA-11 executive dashboard mutasjons-delen (D-216, PR #126), lokal
  whisper.cpp/piper STT/TTS - EKTE subprosess-implementasjon (D-217, PR #128), FEM uavhengige "silent
  error swallowing"-fikser (D-218 scheduler/D-219 policy-avslag-audit/D-220 erasure-fail-status-persist/
  D-221 erasure-rollback-stier/D-222 telegram+advisory-lock+device-registry, PR #130+#132+#133+#134) - se
  git-historikk/DECISIONS_AND_ASSUMPTIONS.md, ikke gjentatt her.
- **D-222 (PR #134) - kort oppsummert (full begrunnelse i DECISIONS_AND_ASSUMPTIONS.md):** femte runde,
  FIRE nye forekomster funnet av et friskt bredt søk utenfor erasure-domenet: (1)
  `TelegramCommandPoller.start()` sin `setInterval(...poll().catch(() => undefined))`
  (`modules/tool-gateway/src/live-transports.ts`) - en poll-tick-feil UTENFOR per-melding-løkken
  forsvant sporløst; (2) SAMME fils per-melding bare `catch {}` rundt `dispatch(chat, text)` - eierens
  EGEN Telegram-melding kunne feile helt sporløst; (3) `withDomainAdvisoryLocks()`
  (`modules/situations/src/advisory-lock.ts`) sin `pg_advisory_unlock`-feil i `finally` - en potensiell
  stuck-lock-kilde uten noe signal; (4) `deviceRegistry.refresh()` i BÅDE `apps/api/src/main.ts`
  (start+intervall) og `worker-main.ts` (start) - en vedvarende feil lot policy kjøre mot et stille
  utdatert enhetsregister. Fikset med SAMME etablerte mønster (strukturert `console.error`, ingen
  atferdsendring i noen av de fire). CI grønt på alle 6 jobber FØRSTE forsøk (inkl. den nye
  embedded-Postgres `advisory-lock.test.ts`, UBEKREFTET lokalt men BEKREFTET av CI), ingen åpne
  review-tråder, merget under D-192 med to-forelder-merge (`24e434b`).

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

1. **Fersk, BREDT kode-nivå gap-søk FØRST** (grep etter BÅDE `.catch(() => undefined)` OG et bart
   `catch { }` uten fanget feil-variabel, HELE `apps/`/`modules/`, ikke bare tidligere rørte filer - se
   D-222-lærdommen over) hvis bedt om å fortsette å bygge - ingen kjent, allerede-registrert uløst
   kandidat gjenstår fra DENNE anti-mønster-klassen akkurat nå (git-auth `chmod()`/GitHub-rate-limit-
   queue-continuation er sjekket og bekreftet lav prioritet flere ganger).
2. Når det kodbare virkelig er oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer, OG Q-32 punkt 1
   (OpenAI som taleprosessor - juridisk/eier-verifisering) og punkt 3 (whisper.cpp/piper-installasjon,
   nå kun host-handling gjenstående, se D-217). PR #97 (W1 watchdog) venter uansett på Tobias/arkitekt.

# PROJECT STATUS

**Oppdatert:** 2026-09-21 (fra fersk `origin/main` HEAD `1e8bc32` = UA-11 executive dashboard
mutasjons-delen, D-216, PR #126 MERGET). **Ingen ny slice startet ennå - se "Neste oppgave" under.**

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

- **PR #106-#126 MERGET.** Gemma-first-sagaen, UA-11 Executive Mode "K2" (D-207), HELE "Charlie"-linjen
  (personlighet D-208/selv-bevissthet D-209/minneverifisering D-210, PR #117-#119), Infisical-wiring +
  integrasjons-dashboard lese-del (D-211, PR #120), voice-gateway daglig-bruk-overflate (D-212, PR #121),
  connector credential-skriving + utvidet live_test (D-213, PR #122), trygg selvendring - to-lags-
  modellen (D-214, PR #123), selvendring - EKTE requires_approval-produsent for vilkårlig kode + merge-
  koblingen (D-215, PR #125), UA-11 executive dashboard mutasjons-delen (D-216, PR #126) - se
  git-historikk/DECISIONS_AND_ASSUMPTIONS.md, ikke gjentatt her.
- **D-215 (task #123, PR #125) - kort oppsummert (full begrunnelse i DECISIONS_AND_ASSUMPTIONS.md):**
  `proposeCodeChange()` sender en full `JobContract` (`agent_profile:"coding"`) via
  `TaskService.submit()` til den eksisterende `createCodingHandler`-pipelinen, rad settes inn
  `status:'pending_job'` (migrasjon 061). `sweepPendingJobs()` følger opp jobben, klassifiserer PR-ens
  FAKTISKE endrede filer når jobben fullfører, ruter til `pending_ci`/`awaiting_approval`/`rejected`.
  `sweepApprovedRequests()` lukker D-214s siste hull: en `/godkjenn`-godkjent rad merges nå via DEN
  SAMME `attemptMerge()` som zero-review-sporet (risikosjekken generalisert til `request.risk`, ALDRI
  `github.merge_pr`). Nytt chat-verktøy `self_modification.propose_code_change` (klasse B). CI grønt
  ved merge (build-test'ens push-triggerte kjøring flaket på den kjente, urelaterte
  `embedded-postgres-port-lease.test.ts`-prosess-port-racen - bekreftet ved at en duplikat
  pull_request-triggert kjøring på SAMME commit besto rent, deretter re-kjørt og grønt).
- **D-216 (task #124, PR #126) - kort oppsummert (full begrunnelse i DECISIONS_AND_ASSUMPTIONS.md):**
  UA-11 Executive dashboard-UI sin MUTASJONS-DELEN (D-199 §7s eksplisitt utsatte gap). De 12 allerede
  bygde, host-proven `executive.*`-mutasjonshandlingene (`pause_domain`/`resume_domain`/
  `resolve_situation`/`activate_kill_switch`/`deactivate_kill_switch`/`freeze_connector`/
  `unfreeze_connector`/`revoke_credential`/`restore_credential`/`revoke_device`/
  `enable_finance_kill_switch`/`disable_finance_kill_switch`) fikk en NY HTTP-rute
  (`POST /executive/mutate`, `apps/api/src/server.ts`, EGET hardkodet allowlist
  `EXECUTIVE_MUTATE_ACTIONS`, ALDRI en utvidelse av `EXECUTIVE_QUERY_ACTIONS`) OG en dashboard-UI
  (`apps/web/dashboard.html`, ny "Kontrollhandlinger"-seksjon). Bekreftelsesdialoger + klasse D-
  preflight (D-199 §7s eksplisitte krav) via `openConfirmModal()` - typed confirmation (skriv EKSAKT
  handlingsnavnet) for de fire klasse D-handlingene (kill switch/finans-nødbryter-parene). Backend
  (`ExecutiveTransport`/`ExecutiveService`) er UENDRET - ren HTTP/UI-overflate. PR #126 fikk et reelt
  merge-conflict (`docs/PROJECT_STATUS.md`/`DECISIONS_AND_ASSUMPTIONS.md`) da PR #125 merget mens
  branchen ventet på CI - løst med en vanlig to-forelder-merge av `origin/main`, quality gates
  re-verifisert etterpå, CI grønt ved merge.

## Blokkeringer

Ingen kjente kode-blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET,
dekker resten av masterplanen: Growth-stack live-evidens, reelle Finance-transaksjoner (Stripe),
iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR. Q-32 punkt 1 (OpenAI som
taleprosessor) og punkt 3 (lokal whisper.cpp/piper) er egne, eier-/eksterne blokkeringer - se
`docs/OPEN_QUESTIONS.md`. D-35s 10-punkts host-produksjonsport for Infisical fortsatt ikke
runtime-verifisert (uendret fra D-211). Embedded-Postgres DB-avhengige tester (`initdb: Permission
denied`) kan fortsatt ikke kjøres i DENNE sandbox-økten - kjent, uendret begrensning; CI (GitHub
Actions) kjører dem derimot uten problemer.

## Neste oppgave

To konkrete, lokalt byggbare kandidater (verifisert i kode, ikke bare antatt) gjenstår før det
kodbare er reelt oppbrukt - se D-216 sin beslutningstekst for den ferske repo-verifiseringen:

1. **Lokal whisper.cpp/piper-adaptere:** `apps/voice-gateway` sin `LocalWhisperStt`/`LocalPiperTts`
   er i dag rene stubs som kaster `not_implemented_in_pilot` - selve subprocess-integrasjonen (spawn
   binær, pipe lyd inn/ut) er ikke skrevet ennå, ikke bare "Tobias må installere binærene". Kan
   bygges/testes nå mot en mock-binær (samme `IMPLEMENTATION_STATUS=B`/`LIVE_EVIDENCE_STATUS=C`-
   splitt som UA-9/UA-10 allerede bruker) - kun LIVE-verifisering venter på at binærene faktisk er
   installert.
2. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer, OG Q-32 punkt 1
   (OpenAI som taleprosessor - juridisk/eier-verifisering) og punkt 3 (whisper.cpp/piper-installasjon).

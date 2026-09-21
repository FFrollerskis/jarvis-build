# PROJECT STATUS

**Oppdatert:** 2026-09-21 (branch `claude/fase-ua11-executive-mutations`, `origin/main` merget inn
etter at HEAD flyttet til `d7b253e` = task #123/D-215/PR #125 MERGET mens denne branchen var i
arbeid). **Task #124 (D-216) implementert, kvalitetsporter kjørt lokalt - klar for
commit/push/oppdatering av PR #126 (se under).**

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

- **PR #106-#125 MERGET.** Gemma-first-sagaen, UA-11 Executive Mode "K2" (D-207), HELE "Charlie"-linjen
  (personlighet D-208/selv-bevissthet D-209/minneverifisering D-210, PR #117-#119), Infisical-wiring +
  integrasjons-dashboard lese-del (D-211, PR #120), voice-gateway daglig-bruk-overflate (D-212, PR #121),
  connector credential-skriving + utvidet live_test (D-213, PR #122), trygg selvendring - to-lags-
  modellen (D-214, PR #123), selvendring - EKTE requires_approval-produsent for vilkårlig kode + merge-
  koblingen (D-215, PR #125) - se git-historikk/DECISIONS_AND_ASSUMPTIONS.md, ikke gjentatt her.
- **D-214 (task #121, PR #123) - kort oppsummert (full begrunnelse i DECISIONS_AND_ASSUMPTIONS.md):**
  ny pakke `modules/self-modification` (`classifySelfModification()` deterministisk klassifisering
  zero_review/requires_approval/forbidden, `SelfModificationService` for eier-kun forslag+CI-portvakt-
  automerge av KUN `config/charlie-personality.json`, en HELT EGEN smalere GitHub-merge-vei som ALDRI
  kaller `github.merge_pr`); to-lags systemprompt i `conversation.ts` (kosmetisk fra config + hardkodet
  `SAFETY_CRITICAL_SUFFIX` alltid appendert ubetinget); `TelegramCommandPoller` fikk `/godkjenn <id>`/
  `/avvis <id>`; migrasjon 060 (`self_modification_requests`, global, ingen RLS).
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
- **Task #124 (D-216) - IKKE ENNÅ PUSHET til PR #126, på branch `claude/fase-ua11-executive-mutations`:**
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
  (`ExecutiveTransport`/`ExecutiveService`) er UENDRET - ren HTTP/UI-overflate. 41 nye/utvidede tester
  (`executive-mutate-wiring.test.ts`: 12 DB-uavhengige, `dashboard-executive-mutations-wiring.test.ts`:
  13 DB-uavhengige, begge verifisert lokalt; `executive-query-e2e.test.ts` beskrivelse G/H/I: 16
  DB-avhengige mot ekte embedded Postgres - IKKE kjørbare lokalt i denne økten, kjent
  `initdb: Permission denied`-begrensning, verifiseres av CI). `pnpm -w typecheck` (32 pakker) og
  `npx eslint .` (hele workspace) rene lokalt; `modules/executive`s egne 72 DB-uavhengige tester
  fortsatt grønne uendret. PR #126 fikk `mergeable_state:"dirty"` da PR #125 merget mens denne
  branchen ventet (begge PR-er rørte `docs/PROJECT_STATUS.md`/`DECISIONS_AND_ASSUMPTIONS.md`) -
  `origin/main` merget inn, konflikter løst i denne commiten. **Gjenstår FØR merge:** push
  merge-oppløsningen, re-verifiser quality gates, overvåk CI på nytt, merge under D-192 når
  grønt/uten åpne funn.

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

1. **Fullfør task #124 (D-216):** push merge-oppløsningen til `claude/fase-ua11-executive-mutations`
   (PR #126), re-verifiser quality gates, overvåk CI, merge under D-192 når grønt/uten åpne funn.
2. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer, OG Q-32 punkt 1
   (OpenAI som taleprosessor - juridisk/eier-verifisering) og punkt 3 (whisper.cpp/piper-installasjon).

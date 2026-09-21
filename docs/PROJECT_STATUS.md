# PROJECT STATUS

**Oppdatert:** 2026-09-21 (branch `claude/fase-self-mod-code-producer` basert på `origin/main` HEAD
`34d669e`). **Task #123 (D-215) implementert, kvalitetsporter kjørt lokalt - klar for
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

## Hvor `main` står nå

- **PR #106-#123 MERGET.** Gemma-first-sagaen, UA-11 Executive Mode "K2" (D-207), HELE "Charlie"-linjen
  (personlighet D-208/selv-bevissthet D-209/minneverifisering D-210, PR #117-#119), Infisical-wiring +
  integrasjons-dashboard lese-del (D-211, PR #120), voice-gateway daglig-bruk-overflate (D-212, PR #121),
  connector credential-skriving + utvidet live_test (D-213, PR #122), trygg selvendring - to-lags-
  modellen (D-214, PR #123) - se git-historikk/DECISIONS_AND_ASSUMPTIONS.md, ikke gjentatt her.
- **D-214 (task #121, PR #123) - kort oppsummert (full begrunnelse i DECISIONS_AND_ASSUMPTIONS.md):**
  ny pakke `modules/self-modification` (`classifySelfModification()` deterministisk klassifisering
  zero_review/requires_approval/forbidden, `SelfModificationService` for eier-kun forslag+CI-portvakt-
  automerge av KUN `config/charlie-personality.json`, en HELT EGEN smalere GitHub-merge-vei som ALDRI
  kaller `github.merge_pr`); to-lags systemprompt i `conversation.ts` (kosmetisk fra config + hardkodet
  `SAFETY_CRITICAL_SUFFIX` alltid appendert ubetinget); `TelegramCommandPoller` fikk `/godkjenn <id>`/
  `/avvis <id>`; migrasjon 060 (`self_modification_requests`, global, ingen RLS). Under CI-kjøringen
  ble tre reelle test-bugs funnet og rettet (git-subcommand-deteksjon i service.test.ts under
  kredensial-isolasjon, `exactOptionalPropertyTypes`/`noUncheckedIndexedAccess`-brudd i to andre
  testfiler, og en stale regex i `ua3-business-events-host-run-wiring.test.ts` som forventet den
  gamle inline `FallbackSecretProvider`-formen `main.ts` sin nye navngitte `readSecretProvider`-
  konstant erstattet) - alle fire commits på PR #123, CI grønt ved merge (5690/5690 tester, alle tre
  jobber build-test/windows-git-auth/gitleaks).
- **Task #123 (D-215) - IKKE ENNÅ PUSHET/PR-et, på branch `claude/fase-self-mod-code-producer`:**
  den bevisst utsatte resten av D-214s to-lags-modell. `proposeCodeChange()` sender en full
  `JobContract` (`agent_profile:"coding"`) via `TaskService.submit()` til den EKSISTERENDE
  `createCodingHandler`-pipelinen (D-96/D-100/D-101), uendret - rad settes inn `status:'pending_job'`
  (ny, migrasjon 061). `sweepPendingJobs()` følger opp jobben via `taskService.get()`, klassifiserer
  PR-ens FAKTISKE endrede filer når jobben fullfører, ruter til `pending_ci` (gjenbruker eksisterende
  zero-review-sveip), `awaiting_approval` (eier-varsel med `/godkjenn`/`/avvis`), eller `rejected`
  (forbidden, umiddelbart). `sweepApprovedRequests()` lukker den siste hullet D-214 bevisst lot stå
  åpen: en `/godkjenn`-godkjent rad merges nå via DEN SAMME `attemptMerge()` som zero-review-sporet
  (risikosjekken generalisert fra hardkodet `"zero_review"` til `request.risk` - dekker begge spor,
  ALDRI `github.merge_pr`). Nytt chat-verktøy `self_modification.propose_code_change` (klasse B).
  Migrasjon 061 utvider status-CHECK med `pending_job` + `coding_task_id`/`coding_tenant_id`-kolonner.
  `apps/api/src/main.ts`: `taskService`/`sendTelegram` hevet tidligere i filen, konstruktørkallet
  fikk `taskService`/`notify`, og to nye uavhengig try/catch'ede periodiske sveiper lagt til.
  34 nye tester (`modules/self-modification/test/{service,transport}.test.ts`: 11 DB-uavhengige
  transport-tester verifisert lokalt, 23 DB-avhengige `service.test.ts`-tester mot ekte embedded
  Postgres - IKKE kjørbare lokalt i denne økten, kjent `initdb: Permission denied`-begrensning,
  verifiseres av CI). `pnpm -w typecheck` (32 pakker) og `npx eslint .` (hele workspace) rene lokalt.
  **Gjenstår FØR PR:** secret-scan (gitleaks), commit, push, draft-PR, overvåk CI (spesielt
  `service.test.ts` sine 23 DB-avhengige tester som kun kan bevises av CI), merge under D-192.

## Blokkeringer

Ingen kjente kode-blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET,
dekker resten av masterplanen: Growth-stack live-evidens, reelle Finance-transaksjoner (Stripe),
iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR. Q-32 punkt 1 (OpenAI som
taleprosessor) og punkt 3 (lokal whisper.cpp/piper) er egne, eier-/eksterne blokkeringer - se
`docs/OPEN_QUESTIONS.md`. D-35s 10-punkts host-produksjonsport for Infisical fortsatt ikke
runtime-verifisert (uendret fra D-211). Embedded-Postgres DB-avhengige tester (`initdb: Permission
denied`) kan fortsatt ikke kjøres i DENNE sandbox-økten - kjent, uendret begrensning; CI (GitHub
Actions) kjører dem derimot uten problemer, og var nettopp det som fanget de tre reelle test-bugene
i D-214-sliceen over.

## Neste oppgave

1. **Fullfør task #123 (D-215):** secret-scan, commit, push `claude/fase-self-mod-code-producer`,
   åpne draft-PR, abonner på PR-aktivitet, overvåk CI (spesielt de 23 DB-avhengige
   `service.test.ts`-testene som kun kan bevises der), merge under D-192 når grønt/uten åpne funn.
2. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer, OG Q-32 punkt 1
   (OpenAI som taleprosessor - juridisk/eier-verifisering) og punkt 3 (whisper.cpp/piper-installasjon).

# PROJECT STATUS

**Oppdatert:** 2026-09-20 (branch `claude/fase-safe-self-modification`, fra fersk `origin/main` HEAD
`79e1d0a` = connector credential-skriving + utvidet live_test (D-213) MERGET). **Ny slice: task #121 -
trygg selvendring, to-lags-modellen (D-214) - klar for kvalitetsporter/commit/push/draft PR.**

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
grense bekreftet igjen for tale (D-212, Q-32 punkt 1) og nå for selvendring (D-208→D-214): eieren
avslo full ugjennomgått selvpatching TO GANGER etter eksplisitt risikogjennomgang - den vedtatte
retningen var et to-lags-kompromiss, ikke en full fullmakt.

## Hvor `main` står nå

- **PR #106-#122 MERGET.** Gemma-first-sagaen, UA-11 Executive Mode "K2" (D-207), HELE "Charlie"-linjen
  (personlighet D-208/selv-bevissthet D-209/minneverifisering D-210, PR #117-#119), Infisical-wiring +
  integrasjons-dashboard lese-del (D-211, PR #120), voice-gateway daglig-bruk-overflate (D-212, PR #121),
  connector credential-skriving + utvidet live_test (D-213, PR #122)
  - se git-historikk/DECISIONS_AND_ASSUMPTIONS.md, ikke gjentatt her.
- **NY slice (IKKE ennå committet): trygg selvendring - to-lags-modellen (D-214, task #121).**
  D-208 avslo full ugjennomgått selvpatching (eieren spurt to ganger, risiko forklart, svar uendret
  begge ganger) og vedtok i stedet: (1) et navngitt, skjemavalidert personlighets-konfig-lag Charlie
  kan foreslå+auto-merge NESTEN ØYEBLIKKELIG uten menneskelig gjennomgang, og (2) en Telegram-basert
  "one-tap" eier-godkjenning for alt annet ikke-forbudt. Denne sliceen leverer begge lag FULLSTENDIG.
  - **Ny pakke `modules/self-modification`:** `policy.ts` sin `classifySelfModification()` - ren,
    deterministisk klassifisering (`zero_review`/`requires_approval`/`forbidden`), hardkodet
    forbudt-liste (policy/owner-controls/self-modification selv/ToolGateway-kjernen/migrasjoner/
    CI/lockfiler/`.env`/`docs/security`/`CLAUDE.md`) VINNER ALLTID over tillatelse, selv blandet.
    `types.ts` sin `PersonalityConfigSchema` (zod `.strict()`) begrenser konfigurasjonen til KUN
    `tone_descriptors`/`style_notes` - strukturelt umulig å injisere frie instruksjoner.
  - **To-lags systemprompt (`conversation.ts`):** `buildSystemPrompt(personality)` (kosmetisk, fra
    config) + en HARDKODET `SAFETY_CRITICAL_SUFFIX` som ALLTID appenderes ubetinget sist, uansett
    konfigurasjonsinnhold. Ny `personality-config.ts` (`loadPersonalityConfig()`) leser
    `config/charlie-personality.json` FRISK per samtaletur, fail-closed til default på enhver feil.
  - **`SelfModificationService`:** `proposePersonalityChange()` (eier-kun, sandboxet git-pipeline →
    `publishPullRequestForCodingJob()`, SAMME PR-mekanisme som UA-5 kodeagenten). `sweepPendingRequests()`
    (periodisk, 60s) er CI-portvakten: CI-grønt FØRST, FERSK diff-reverifisering fra GitHub DERETTER,
    kun DA merge. En HELT EGEN, smalere GitHub-merge-vei (`github-client.ts`) - BEVISST ALDRI
    `github.merge_pr` (klasse D, forblir uendret en separat eier-autorisert handling).
  - **Godkjenningskanalen:** `TelegramCommandPoller` fikk `/godkjenn <id>`/`/avvis <id>` (SAMME betrodde
    eier-chat-binding som `/brief`/`/status`, IKKE en ny Ed25519-signatur - eierens eget, bevisste valg).
    `resolveApproval()` er den generiske godkjennings-tilstandsmaskinen.
  - **Migrasjon 060:** `self_modification_requests` (INGEN tenant_id/RLS - global sovereign
    eier-handling, SAMME presedens som `owner_control_state`).
  - **Chat-verktøy:** KUN `self_modification.propose_personality_change` (klasse B) - merge/godkjenning
    er BEVISST IKKE chat-kallbare.
  - **BEVISST UTSATT til ny task #123:** produsent av EKTE `requires_approval`-forespørsler for
    vilkårlige kodeendringer (gjenbruker `createCodingHandler`/`ClaudeCodeAgent`) + siste
    Telegram-godkjenning-gated merge-kobling for den veien.
  - 81 nye tester: 57 DB-uavhengige verifisert lokalt (`modules/self-modification/test/{policy,
    transport,github-client}.test.ts`, `modules/tool-gateway/test/d214-telegram-self-mod-approval.test.ts`,
    `apps/api/test/d214-personality-system-prompt.test.ts`) + 24 DB-avhengige
    (`modules/self-modification/test/service.test.ts`, kjent sandbox-begrensning, verifiseres av CI).
    `pnpm -w typecheck` (33 pakker) og `npx eslint .` rene.

## Blokkeringer

Ingen kjente kode-blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET,
dekker resten av masterplanen: Growth-stack live-evidens, reelle Finance-transaksjoner (Stripe),
iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR. Q-32 punkt 1 (OpenAI som
taleprosessor) og punkt 3 (lokal whisper.cpp/piper) er egne, eier-/eksterne blokkeringer - se
`docs/OPEN_QUESTIONS.md`. D-35s 10-punkts host-produksjonsport for Infisical fortsatt ikke
runtime-verifisert (uendret fra D-211). Embedded-Postgres DB-avhengige tester (`initdb: Permission
denied`) kan fortsatt ikke kjøres i DENNE sandbox-økten - kjent, uendret begrensning siden D-211/D-212/
D-213, verifiseres av CI.

## Neste oppgave

1. **Fullfør denne sliceen (D-214):** secret-scan, commit, push til `claude/fase-safe-self-modification`,
   draft PR, abonner.
2. **Deretter (ny task #123):** produsent av EKTE `requires_approval`-selvendringsforespørsler for
   vilkårlige kodeendringer + Telegram-godkjenning-gated merge for den veien (se D-214 sitt "bevisst
   utsatt"-avsnitt).
3. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer, OG Q-32 punkt 1
   (OpenAI som taleprosessor - juridisk/eier-verifisering) og punkt 3 (whisper.cpp/piper-installasjon).

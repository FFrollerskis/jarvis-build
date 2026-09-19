# PROJECT STATUS

**Oppdatert:** 2026-09-19 (branch `claude/d166-cross-worker-task-admission`, merget med fersk `main`
FLERE ganger etter hvert som `main` beveget seg - siste merge inkluderer PR #98). **PR #96 (W1) OG
PR #98 (post-merge status) er MERGET** (`main` HEAD `79ba9ae...`). Aktiv oppgave: **PR #87 (D-166,
cross-worker task-admission-eksklusivitet) - CI grønt på merget branch, klar for merge under D-192.**

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## ARBEIDSFORM-ENDRING (D-192, 2026-09-19)

Tobias har DIREKTE (i interaktiv chat, ikke via issue #68 `ARCHITECT_TASK`) bedt om å bygge resten av
planen sammen med Claude uten ChatGPT-arkitekten som mellomledd. issue #68 BEHOLDES som logg
(`CLAUDE_REPORT` posteres der fortsatt), men oppgave-autoritet kommer nå fra chat. Claude har STÅENDE
FULLMAKT til å merge rutinemessige PR-er selv når CI er grønt/tester består/ingen åpne funn - varsler,
spør ikke. `HARD_EXTERNAL_BLOCKER` (credentials/betaling/fysisk host-handling/juridisk aksept) stopper
fortsatt alltid og varsler Tobias direkte. Se D-192 i DECISIONS_AND_ASSUMPTIONS.md og oppdatert
`CLAUDE.md` §Merge-autoritet. Brukt for PR #96 og PR #98; PR #87 er tredje bruk.

## Hvor `main` står nå

- **PR #95 (B2+B3, D-174→D-179) MERGET.**
- **PR #96 (W1, D-180→D-193) MERGET** (`9f13223`) - fullt host-bevist (`run_id=28c2059a`,
  `hard_fail=false`, 16/16 markører PASS).
- **PR #98 (post-W1-merge status-oppdatering) MERGET** (`79ba9ae`).
- **PR #87 (D-166 - cross-worker task-admission-eksklusivitet) - KLAR FOR MERGE.** Fikser en reell race
  condition: `acquireLock` ga gjensidig utelukkelse per LÅSEFIL, ikke per `TASK_ID` - to
  worker-deployments kunne begge dispatche barn for samme ordre samtidig (observert på ekte data,
  issue #68: to `CLAUDE_ACK`/`CLAUDE_REPORT`-par for D-165). Ny `ops/claude-worker/lib/
  task-admission.mjs`: append-only, versjonert CAS-leie per `TASK_ID`, tatt FØR autoritetsporten/
  ordrebindingen/enhver GitHub-skriving. Fail-closed på alle utfall. Scope: KUN `ops/claude-worker/**`
  - rører ikke Jarvis-produktkoden, rører ikke `main`/PR #83/PR #86 (allerede merget/urørt historisk).
  Merget med fersk `main` TO ganger i denne økten (main beveget seg videre pga. PR #98 midt i CI-
  ventingen) - KUN `docs/PROJECT_STATUS.md`/`docs/DECISIONS_AND_ASSUMPTIONS.md` hadde konflikt begge
  ganger (trivielt løst, selve kodeendringen alltid rent). **Full lokal regresjon: 1360/1360 tester
  grønt** (40 testfiler i `ops/claude-worker/test/`, inkl. 28/28 `task-admission.test.mjs` med ekte
  10-prosess-samtidighet). GitHub CI: alle 6 sjekker grønt (gitleaks/build-test/windows-git-auth ×
  push+pull_request). Godkjent av Tobias direkte (D-192) for konfliktløsning+re-test+merge.
- **V1 Value Track** (D181 sitt funn, `INTERNAL_BUILD_COMPLETE`-relatert) IKKE startet.

## Blokkeringer

Ingen kjente blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET, dekker
resten av masterplanen: AI-leverandørfamilier, Growth-stack live-evidens, reelle Finance-transaksjoner
(Stripe), iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR.

## Neste oppgave

1. Merge PR #87 under D-192 (siste HEAD-/base-guard rett før merge, siden `main` har beveget seg mens
   CI kjørte).
2. Videre bygging av gjenstående plan-elementer direkte med Tobias - prioritert rekkefølge avklares i
   chat (V1 Value Track vs. en samlet oversikt over API-nøkler/kontoer/MCP-koblinger for de eksterne
   blokkeringene nevnt over).

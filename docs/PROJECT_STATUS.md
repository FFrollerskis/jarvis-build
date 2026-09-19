# PROJECT STATUS

**Oppdatert:** 2026-09-19 (branch `claude/d166-cross-worker-task-admission`, merget med fersk `main`).
**PR #96 (W1) er MERGET** (`MERGE_SHA=9f13223...`, under D-192 stående fullmakt - full host-bevist).
Aktiv oppgave: **fullføre PR #87 (D-166, cross-worker task-admission-eksklusivitet) - konflikter mot
fersk main løst, regresjon kjøres på nytt før merge.**

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## ARBEIDSFORM-ENDRING (D-192, 2026-09-19)

Tobias har DIREKTE (i interaktiv chat, ikke via issue #68 `ARCHITECT_TASK`) bedt om å bygge resten av
planen sammen med Claude uten ChatGPT-arkitekten som mellomledd. issue #68 BEHOLDES som logg
(`CLAUDE_REPORT` posteres der fortsatt), men oppgave-autoritet kommer nå fra chat. Claude har STÅENDE
FULLMAKT til å merge rutinemessige PR-er selv når CI er grønt/tester består/ingen åpne funn - varsler,
spør ikke. `HARD_EXTERNAL_BLOCKER` stopper fortsatt alltid og varsler Tobias direkte. Se D-192 i
DECISIONS_AND_ASSUMPTIONS.md og oppdatert `CLAUDE.md` §Merge-autoritet. Første bruk: PR #96 (W1)
merget under denne fullmakten 2026-09-19.

## Hvor `main` står nå

- **PR #95 (B2+B3, D-174→D-179) MERGET.**
- **PR #96 (W1, D-180→D-193) MERGET** (`9f13223`, 2026-09-19) - fullt host-bevist
  (`run_id=28c2059a`, `hard_fail=false`, 16/16 markører PASS). Se DECISIONS_AND_ASSUMPTIONS.md.
- **PR #98** (post-W1-merge status-oppdatering, docs-only) - åpen, venter CI, merges under D-192.
- **PR #87 (D-166 - cross-worker task-admission-eksklusivitet) - UNDER FERDIGSTILLELSE NÅ.** Fikser en
  reell race condition: `acquireLock` ga gjensidig utelukkelse per LÅSEFIL, ikke per `TASK_ID` - to
  worker-deployments kunne begge dispatche barn for samme ordre samtidig (observert på ekte data,
  issue #68: to `CLAUDE_ACK`/`CLAUDE_REPORT`-par for D-165). Ny `ops/claude-worker/lib/
  task-admission.mjs`: en append-only, versjonert CAS-leie per `TASK_ID` i en delt rot, tatt FØR
  autoritetsporten/ordrebindingen/enhver GitHub-skriving. Fail-closed på alle utfall (ugjenlesbar
  leie, fremmed vert, tvetydig status). 28/28 + 179/179 tester (per PR-body, ikke enda re-kjørt i
  denne økten), `pnpm -w lint`/`typecheck` rene. Scope: KUN `ops/claude-worker/**` - rører ikke
  Jarvis-produktkoden (`modules/`, `apps/`), rører ikke `main`/PR #83/PR #86 (allerede merget/urørt
  historisk). Base var foreldet (`14a12fd1`, fra 2026-09-17) - merget med fersk `main` i denne økten;
  KUN `docs/DECISIONS_AND_ASSUMPTIONS.md`/`docs/PROJECT_STATUS.md` hadde konflikt (begge trivielt
  løst - selve kodeendringen merget helt rent). Godkjent av Tobias direkte (D-192) for
  konfliktløsning+re-test+merge, IKKE en ny arkitekt-forhåndsreview (erstattet av D-192 for denne
  økten).
- **V1 Value Track** (D181 sitt funn, `INTERNAL_BUILD_COMPLETE`-relatert) IKKE startet.

## Blokkeringer

Ingen kjente blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET, dekker
resten av masterplanen: AI-leverandørfamilier, Growth-stack live-evidens, reelle Finance-transaksjoner
(Stripe), iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR.

## Neste oppgave

1. Kjør full `ops/claude-worker`-regresjon på nytt mot den merge-committede branchen (28/28
   task-admission + 179/179 config/reconcile/reconcile-provenance/state/lock + lint + typecheck).
2. Push, vent CI, merge PR #87 under D-192.
3. Deretter: videre bygging av gjenstående plan-elementer direkte med Tobias - prioritert rekkefølge
   avklares i chat, inkl. en samlet oversikt over hvilke API-nøkler/kontoer/MCP-koblinger som trengs
   for de eksterne blokkeringene nevnt over.

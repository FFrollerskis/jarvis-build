# PROJECT STATUS

**Oppdatert:** 2026-09-19 (branch `claude/w1-watchdog-runtime-durability`, PR #96 - draft, åpen, CI
GRØNT på eksakt HEAD `34080a6396b5502211e378ce0a3b07d1f934228e`, base
`main=9ede3ac1d2e32e708d38104e7a6869772774d628` = PR #95 sin merge-commit). Aktiv oppgave: **fullføre
PR #96 (W1) helt - eneste gjenstående steg er ekte host-akseptanse (krever Tobias sin Windows/Docker/
Postgres-maskin, kan ikke kjøres fra denne sandkassen).**

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## ARBEIDSFORM-ENDRING (D-192, 2026-09-19)

Tobias har DIREKTE (i interaktiv chat, ikke via issue #68 `ARCHITECT_TASK`) bedt om å bygge resten av
planen sammen med Claude uten ChatGPT-arkitekten som mellomledd. issue #68 BEHOLDES som logg
(`CLAUDE_REPORT` posteres der fortsatt), men oppgave-autoritet kommer nå fra chat. Claude har STÅENDE
FULLMAKT til å merge rutinemessige PR-er selv når CI er grønt/tester består/ingen åpne funn - varsler,
spør ikke. `HARD_EXTERNAL_BLOCKER` (credentials/betaling/fysisk host-handling/juridisk aksept) stopper
fortsatt alltid og varsler Tobias direkte. Se D-192 i DECISIONS_AND_ASSUMPTIONS.md og oppdatert
`CLAUDE.md` §Merge-autoritet.

## Hvor `main`/PR #96 står nå

- **PR #95 (B2+B3, D-174→D-179) er MERGET til `main`** (`MERGE_SHA=9ede3ac1...`).
- **PR #96 (`claude/w1-watchdog-runtime-durability`) er ÅPEN, DRAFT, CI GRØNT på HEAD `34080a6`.**
  Full sekvens D-180→D-192 er nå logget i DECISIONS_AND_ASSUMPTIONS.md (D-182/186/187/190/191/192 ble
  lagt til i denne økten - de manglet fra loggen selv om de var GitHub-issue-postet og kodet/testet).
  W1 (watchdog: databaseCheck/stuckTasksCheck/costExplosionCheck) er nå: produksjonswiret,
  durabel/delt kill-switch-aktivering, nødvarsel som overlever egen kill switch, config-validert
  (fail-closed mot NaN-hardgrense), og RLS-tenant-skopet under den ekte runtime-rollen (D-191/B4 - den
  alvorligste av rettelsene: kostnadssjekken kunne strukturelt ALDRI utløses i produksjon før denne
  fiksen). Alt kode-/CI-bevist. **`HOST_ACCEPTANCE_STATUS=REQUIRES_RERUN`** - IKKE kjørt ennå for denne
  HEAD-en.
- **PR #87** forblir ÅPEN, IKKE rørt (`mergeable=CONFLICTING` mot main, klassifisert
  `STALE_OR_SUPERSEDED`). Neste i køen ETTER PR #96 er lukket.
- **V1 Value Track** (D181 sitt funn, `INTERNAL_BUILD_COMPLETE`-relatert) IKKE startet.

## Blokkeringer

1. **Host-akseptanse for W1 (`w1-watchdog-durability-host-run.ts`) er `REQUIRES_RERUN`** - krever
   Tobias sin ekte Windows/Docker/Postgres-host. Kommando (fra repo-roten, på hosten):
   `node --env-file=.env --experimental-transform-types modules/watchdog/scripts/w1-watchdog-durability-host-run.ts`
   Se scriptets filhode for sikkerhetsmerknader (aktiverer ekte kill switch kortvarig, kjør ikke
   samtidig med annen Jarvis-bruk). Suksess = script avslutter med `hard_fail=false` i sammendraget.
2. **`EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS`** (D-170) - UENDRET, dekker resten av masterplanen utover
   W1: AI-leverandørfamilier, Growth-stack live-evidens, reelle Finance-transaksjoner (Stripe),
   iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
   `docs/SOVEREIGN_GRADUATION_MATRIX.md` for full oversikt. `SOVEREIGN_COMPLETE=false` FORBLIR.

## Neste oppgave

1. Tobias kjører W1 host-akseptanse (kommando over) og gir Claude resultatet (output/`hard_fail`).
2. Går den grønt: Claude merger PR #96 selv (D-192 stående fullmakt - normal two-parent merge, ingen
   force/squash/rebase), oppdaterer SOVEREIGN_GRADUATION_MATRIX.md sin W1-rad til
   `HOST_ACCEPTANCE_STATUS=PASS`, varsler Tobias.
3. Deretter: rydde/reissue PR #87, så videre bygging av gjenstående plan-elementer direkte med Tobias
   (prioritert rekkefølge avklares i chat), inkl. en samlet oversikt over hvilke API-nøkler/
   kontoer/MCP-koblinger som trengs for de eksterne blokkeringene i punkt 2 over.

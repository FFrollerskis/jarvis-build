# PROJECT STATUS

**Oppdatert:** 2026-09-19 (branch `claude/post-w1-merge-status` av `main`). **PR #96 (W1) er MERGET til
`main`** (`MERGE_SHA=9f13223d09b354bb0698169cc5be45d3bdc3063e`, normal two-parent merge, under D-192
stående fullmakt). Aktiv oppgave: **rydde/reissue PR #87, deretter videre bygging av gjenstående
plan-elementer direkte med Tobias.**

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser/DECISIONS_AND_ASSUMPTIONS.md, ikke her.

## ARBEIDSFORM-ENDRING (D-192, 2026-09-19)

Tobias har DIREKTE (i interaktiv chat, ikke via issue #68 `ARCHITECT_TASK`) bedt om å bygge resten av
planen sammen med Claude uten ChatGPT-arkitekten som mellomledd. issue #68 BEHOLDES som logg
(`CLAUDE_REPORT` posteres der fortsatt), men oppgave-autoritet kommer nå fra chat. Claude har STÅENDE
FULLMAKT til å merge rutinemessige PR-er selv når CI er grønt/tester består/ingen åpne funn - varsler,
spør ikke. `HARD_EXTERNAL_BLOCKER` (credentials/betaling/fysisk host-handling/juridisk aksept) stopper
fortsatt alltid og varsler Tobias direkte. Se D-192 i DECISIONS_AND_ASSUMPTIONS.md og oppdatert
`CLAUDE.md` §Merge-autoritet. **Denne posten er selve det FØRSTE eksemplet på fullmakten i bruk** - PR
#96 ble merget uten en separat ChatGPT-forhåndsreview, kun mot Tobias sin egen sanntids
chat-tilstedeværelse + ekte host-akseptansebevis.

## Hvor `main` står nå

- **PR #95 (B2+B3, D-174→D-179) MERGET** (`MERGE_SHA=9ede3ac1...`).
- **PR #96 (W1, D-180→D-193) MERGET** (`MERGE_SHA=9f13223...`, 2026-09-19). `@jarvis/watchdog` er nå
  produksjonswiret i `worker-main.ts`, med durabel/delt kill-switch-aktivering, nødvarsel som overlever
  egen kill switch, fail-closed config-validering, RLS-tenant-skopet kostnadssjekk, og eier-
  gjenoppretting via kanonisk `owner_controls.*`-vei - **ALT host-bevist** (Tobias, ekte Windows/Docker/
  Postgres, `run_id=28c2059a`, `hard_fail=false`, 16/16 markører PASS). Full D-180→D-193-historikk i
  DECISIONS_AND_ASSUMPTIONS.md.
  - Merket: CI feilet forbigående to ganger på siste commit (`runner_id=0`, ingen runner tildelt på
    ~3 sek) - diagnostisert som en CI-infrastrukturhikke (mulig midlertidig runner-kapasitetsbegrensning
    for kontoen), IKKE en kodefeil (alle andre commits på branchen bygget/testet normalt med ekte
    varighet). Tredje forsøk kjørte normalt og ble grønt.
- **PR #87** forblir ÅPEN, IKKE rørt (`mergeable=CONFLICTING` mot main, klassifisert
  `STALE_OR_SUPERSEDED`). Neste i køen.
- **V1 Value Track** (D181 sitt funn, `INTERNAL_BUILD_COMPLETE`-relatert) IKKE startet.

## Blokkeringer

Ingen kjente blokkeringer for videre arbeid akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) -
UENDRET, dekker resten av masterplanen: AI-leverandørfamilier, Growth-stack live-evidens, reelle
Finance-transaksjoner (Stripe), iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md` for full oversikt. `SOVEREIGN_COMPLETE=false` FORBLIR.

## Neste oppgave

1. Rydde opp/reissue PR #87 (stale, konflikt mot main).
2. Videre bygging av gjenstående plan-elementer direkte med Tobias (D-192 arbeidsform) - prioritert
   rekkefølge avklares i chat, inkl. en samlet oversikt over hvilke API-nøkler/kontoer/MCP-koblinger som
   trengs for de eksterne blokkeringene nevnt over.

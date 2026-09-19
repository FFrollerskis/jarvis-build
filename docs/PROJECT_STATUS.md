# PROJECT STATUS

**Oppdatert:** 2026-09-19 (branch `claude/w1-watchdog-runtime-durability`, PR #96 - draft, åpen). W1 er
nå FULLT host-bevist (Tobias, ekte Windows/Docker/Postgres, `run_id=28c2059a`, `hard_fail=false`, 16/16
markører PASS). Aktiv oppgave: **siste pre-merge-sjekker, deretter merge PR #96 (D-192 stående
fullmakt).**

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
- **PR #96 (`claude/w1-watchdog-runtime-durability`) er ÅPEN, DRAFT, CI GRØNT på HEAD `97a86d2`.**
  Full sekvens D-180→D-193 logget i DECISIONS_AND_ASSUMPTIONS.md.
- **D-193 (BLOKKER B5) BEKREFTET LIVE (2026-09-19):** Tobias sin ANDRE host-kjøring
  (`run_id=28c2059a`, mot HEAD `97a86d2`) ga 16/16 PASS, `hard_fail=false` - inkl. seksjon 9 (eier-
  gjenoppretting via kanonisk `owner_controls.*`-vei), som feilet i FØRSTE kjøring (`run_id=90b827b3`)
  pga. en harness-only credential-provider-defekt (fikset, ikke produksjonskode). W1 er dermed FULLT
  live-bevist: `HOST_ACCEPTANCE_STATUS=PASS`.
- **PR #87** forblir ÅPEN, IKKE rørt (`mergeable=CONFLICTING` mot main, klassifisert
  `STALE_OR_SUPERSEDED`). Neste i køen ETTER PR #96 er lukket.
- **V1 Value Track** (D181 sitt funn, `INTERNAL_BUILD_COMPLETE`-relatert) IKKE startet.

## Blokkeringer

Ingen kjente blokkeringer for PR #96 selv. Gjenstår kun pre-merge-verifisering (fresh fetch, HEAD-/
base-guard, ingen åpne review-tråder) før merge under D-192 sin stående fullmakt.

`EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET, dekker resten av masterplanen utover W1:
AI-leverandørfamilier, Growth-stack live-evidens, reelle Finance-transaksjoner (Stripe), iPhone/Watch/
Home/Personal/Health LIVE, off-site backup/monitoring. Se `docs/SOVEREIGN_GRADUATION_MATRIX.md` for
full oversikt. `SOVEREIGN_COMPLETE=false` FORBLIR (uavhengig av PR #96 sin merge).

## Neste oppgave

1. Pre-merge-sjekk (fresh fetch, PR fortsatt åpen/draft/unmerget, exact HEAD/base, ingen åpne
   review-tråder), deretter merge PR #96 til `main` (D-192 - normal two-parent merge).
2. Poste avsluttende `CLAUDE_REPORT` til issue #68 (D-192 holder issue #68 som logg).
3. Post-merge: fresh-read `main`, oppdater denne filen igjen med reelt post-merge-status.
4. Deretter: rydde/reissue PR #87, så videre bygging av gjenstående plan-elementer direkte med Tobias
   (prioritert rekkefølge avklares i chat), inkl. en samlet oversikt over hvilke API-nøkler/
   kontoer/MCP-koblinger som trengs for de eksterne blokkeringene nevnt over.

# PROJECT STATUS

**Oppdatert:** 2026-09-19 (branch `claude/w1-watchdog-runtime-durability`, PR #96 - draft, åpen). Første
ekte host-kjøring (Tobias, Windows/Docker/Postgres, `run_id=90b827b3`, mot HEAD `82c45b0`) fant BLOKKER
B5 (D-193) - fikset, IKKE re-kjørt på host ennå. Aktiv oppgave: **push B5-fiksen, vent CI, be Tobias
kjøre host-akseptansen på nytt.**

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
- **PR #96 (`claude/w1-watchdog-runtime-durability`) er ÅPEN, DRAFT.** Full sekvens D-180→D-193 er nå
  logget i DECISIONS_AND_ASSUMPTIONS.md.
- **D-193 (BLOKKER B5, 2026-09-19):** Tobias sin FØRSTE ekte host-kjøring (`run_id=90b827b3`) ga 15/16
  PASS - selve W1-mekanismen (durabel kill switch, nødvarsel som overlever egen kill switch, kryss-
  prosess-/restart-simulering, policy-håndhevelse, ingen duplikat-aktivering, opprydding) er DERMED
  LIVE-BEVIST. Seksjon 9 ("eier-gjenoppretting via KANONISK vei",
  `owner_controls.deactivate_kill_switch`/`get_control_state`) FEILET - diagnostisert som en
  harness-defekt (manglende `BusinessInternalSecretProvider` i `w1-watchdog-durability-live.ts` sin
  `secrets`-oppsett, IKKE noe galt i produksjonskoden - `main.ts`/`worker-main.ts` har alltid hatt dette
  riktig). Fikset, 4 nye regresjonstester, typecheck/lint/95 tester grønt lokalt. **IKKE re-kjørt på
  host ennå** - `HOST_ACCEPTANCE_STATUS=REQUIRES_RERUN` FORBLIR til en fersk kjøring bekrefter B5-fiksen
  OG at de 15 allerede-PASS-markørene fortsatt er PASS.
- **PR #87** forblir ÅPEN, IKKE rørt (`mergeable=CONFLICTING` mot main, klassifisert
  `STALE_OR_SUPERSEDED`). Neste i køen ETTER PR #96 er lukket.
- **V1 Value Track** (D181 sitt funn, `INTERNAL_BUILD_COMPLETE`-relatert) IKKE startet.

## Blokkeringer

1. **Host-akseptanse for W1 er `REQUIRES_RERUN`** - krever Tobias sin ekte Windows/Docker/Postgres-host
   (samme kommando som før, kjøres fra repo-roten på hosten, ETTER at branchen er oppdatert til ny HEAD):
   `node --env-file=.env --experimental-transform-types modules/watchdog/scripts/w1-watchdog-durability-host-run.ts`
   Suksess = script avslutter med `hard_fail=false` i sammendraget (ALLE 16 markører PASS, ikke bare 15).
2. **`EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS`** (D-170) - UENDRET, dekker resten av masterplanen utover
   W1: AI-leverandørfamilier, Growth-stack live-evidens, reelle Finance-transaksjoner (Stripe),
   iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
   `docs/SOVEREIGN_GRADUATION_MATRIX.md` for full oversikt. `SOVEREIGN_COMPLETE=false` FORBLIR.

## Neste oppgave

1. Push D-193/B5-fiksen, vent på grønn CI på ny HEAD.
2. Tobias oppdaterer sin lokale checkout (`git pull origin claude/w1-watchdog-runtime-durability`) og
   kjører W1 host-akseptanse på nytt (kommando over), gir Claude resultatet.
3. Går den grønt (16/16): Claude merger PR #96 selv (D-192 stående fullmakt - normal two-parent merge,
   ingen force/squash/rebase), oppdaterer SOVEREIGN_GRADUATION_MATRIX.md sin W1-rad til
   `HOST_ACCEPTANCE_STATUS=PASS`, varsler Tobias.
4. Deretter: rydde/reissue PR #87, så videre bygging av gjenstående plan-elementer direkte med Tobias
   (prioritert rekkefølge avklares i chat), inkl. en samlet oversikt over hvilke API-nøkler/
   kontoer/MCP-koblinger som trengs for de eksterne blokkeringene i punkt 2 over.

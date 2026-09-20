# PROJECT STATUS

**Oppdatert:** 2026-09-20 (branch `main`, HEAD `4c92953` = PR #115 MERGET). **UA-11 Executive Mode "K2"
er FERDIG BYGGET OG MERGET denne økten** (D-207): decision log, scenarios, risk register, goals/OKRs
(ny pakke `@jarvis/governance`) + delegation board (ren komposisjon i `@jarvis/executive`, ingen ny
tabell). CI grønt (build-test/gitleaks/windows-git-auth), ingen åpne review-tråder - merget under
D-192s stående fullmakt.

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

## Hvor `main` står nå

- **PR #106-#113 MERGET, Gemma-first-sagaen (D-79/D-80 → D-200 → D-206) er LUKKET, host-bevist fra
  ende til ende** (se forrige økts detaljer i git-historikken/DECISIONS_AND_ASSUMPTIONS.md D-200-D-206).
- **PR #115 MERGET (2026-09-20, `MERGE_SHA=4c929538bb8ac4af64421f8525f77df0f3622e5c`): UA-11 Executive
  Mode "K2" (D-207)** - masterplanens fem gjenstående K2-bullets ("Decision log, scenarios, risk
  register, goals/OKRs, delegation board") lukket samlet, etter Tobias sitt "alle"-svar på hvilken
  delkomponent å prioritere:
  - Ny pakke `@jarvis/governance` (migrasjon `059_governance.sql`: `decision_log`/`scenarios`/`risks`/
    `goals`+`goal_key_results`, standard tenant+space-RLS, scope-safe FK mot `situations`). 14
    handlinger, ALLE klasse A/B (rene interne journalposter, ZERO klasse C/D).
  - `executive.get_delegation_board` (ny, klasse A) - "delegation board" BEVISST IKKE en femte tabell
    (D-64): ren komposisjon av `situations.list_autonomy_policies`+`owner_controls.get_control_state`+
    `finance.get_kill_switch`, samme mønster som `get_control_surface_status`.
  - Wiret i `apps/api/src/main.ts` (samme `additionalTools`-løkke), registrert i
    `modules/erasure/src/plan.ts` (Q-20, 5 nye rader).
  - Docs: D-207 i DECISIONS_AND_ASSUMPTIONS.md, `docs/UA11_EXECUTIVE_MODE_DESIGN.md` §10, ny K2-seksjon
    i `docs/IMPLEMENTATION_PLAN.md`, ny rad i `docs/RUNTIME_GATES.md`.
  - **CI-funn og fiks (samme økt, FØR merge):** `build-test` feilet FØRST på ekte CI-Postgres (denne
    sandboxen kunne aldri kjøre `service-rls.test.ts` selv pga. sin egne `initdb: Permission denied`-
    begrensning) - `decision_log`/`scenarios`/`risks`/`goals.created_by` sin FK mot `people(person_id)`
    ble brutt fordi test-fixturene brukte `"person-creator"`/`"p"` uten å faktisk sette inn de radene i
    `people`. Rettet ved å seede begge i `beforeAll` (commit `4b231b1`) - ny CI-kjøring 100% grønn
    (`build-test`/`gitleaks`/`windows-git-auth`, to parallelle runs, alle 6 checks `success`).
  - `pnpm --filter @jarvis/governance typecheck`/`pnpm --filter @jarvis/executive typecheck`/
    `pnpm --filter @jarvis/api typecheck`/`pnpm --filter @jarvis/erasure typecheck` og `npx eslint` på
    alle berørte pakker: RENE (lokalt OG i CI).
  - **Tester:** `modules/governance/test/transport-wiring.test.ts` (11, DB-uavhengig) grønt lokalt OG i
    CI. `modules/governance/test/service-rls.test.ts` (17, ekte embedded Postgres/RLS) grønt i CI
    (KUN etter FK-fiksen over) - IKKE kjørbart lokalt i denne sandboxen (kjent, pre-eksisterende
    `initdb: Permission denied`-begrensning, samme som D-193→D-199).
  - `HOST_ACCEPTANCE_REQUIRED=false` for hele K2 - ZERO ny ekstern leverandør/credential/runtime-
    avhengighet.

## Blokkeringer

Ingen kjente kode-blokkeringer akkurat nå. `EXTERNAL_RUNTIME_EVIDENCE_BLOCKERS` (D-170) - UENDRET,
dekker resten av masterplanen: Growth-stack live-evidens, reelle Finance-transaksjoner (Stripe),
iPhone/Watch/Home/Personal/Health LIVE, off-site backup/monitoring. Se
`docs/SOVEREIGN_GRADUATION_MATRIX.md`. `SOVEREIGN_COMPLETE=false` FORBLIR.

## Neste oppgave

1. **Neste masterplan-slice:** avklar med Tobias hvilken gjenstående, kodbar masterplan-kapabilitet som
   skal bygges videre (ingen eksplisitt utpekt ennå etter K2).
2. Når det kodbare er reelt oppbrukt: legg frem en samlet oversikt over API-nøkler/kontoer/
   MCP-koblinger Tobias må skaffe for D-170s gjenstående eksterne blokkeringer (Stripe/Neonomics/
   Google Ads gjenstår fortsatt, se tidligere øktnotater).
